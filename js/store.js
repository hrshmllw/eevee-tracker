// Data layer: Firestore (private, per Google account) with offline persistence.
// Layout: users/{uid}/items/{id}, users/{uid}/notes/{id}, users/{uid}/photos/{key},
//         users/{uid}/meta/collection (notes, aliases, group order), users/{uid}/meta/settings (Gemini key).
// Writes apply locally at once and Firestore syncs them, queuing across reloads while offline.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  signInWithEmailAndPassword, signOut as fbSignOut, EmailAuthProvider, linkWithCredential, updatePassword,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot,
  setDoc, updateDoc, deleteDoc, getDoc, writeBatch, Bytes,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { settings, saveSettings } from './settings.js';
import { today, nowIso } from './util.js';

export const configured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
const app = configured ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  ignoreUndefinedProperties: true,
}) : null;

export const store = new EventTarget();
store.user = null;
store.data = { collection: { updated: '', meta: {}, items: [] }, notes: { notes: [] } };
store.status = { authReady: false, loaded: false, fromCache: false, error: '', offline: !navigator.onLine, pending: 0, writing: 0, loadedAt: 0 };

const emit = (type) => store.dispatchEvent(new Event(type));
const raw = { items: [], notes: [], meta: {}, pend: { items: 0, notes: 0, meta: 0 }, got: new Set() };
let unsubs = [];
const photoUrls = new Map();
const photoLoading = new Map();

function setStatus(patch) {
  Object.assign(store.status, patch);
  store.status.pending = raw.pend.items + raw.pend.notes + raw.pend.meta + store.status.writing;
  emit('status');
}

const ref = {
  items: () => collection(db, 'users', store.user.uid, 'items'),
  notes: () => collection(db, 'users', store.user.uid, 'notes'),
  meta: (name) => doc(db, 'users', store.user.uid, 'meta', name),
  photo: (path) => doc(db, 'users', store.user.uid, 'photos', photoKey(path)),
};
const photoKey = (path) => String(path).replace(/[/\\]/g, '__').replace(/^\.+/, '_').slice(0, 1400);

function rebuild() {
  store.data = {
    collection: { updated: raw.meta.updated || '', meta: raw.meta, items: raw.items },
    notes: { notes: raw.notes },
  };
  emit('change');
}

function listen() {
  for (const u of unsubs) u();
  photoUrls.forEach((u) => URL.revokeObjectURL(u));
  photoUrls.clear();
  raw.items = []; raw.notes = []; raw.meta = {}; raw.got.clear();
  raw.pend = { items: 0, notes: 0, meta: 0 };
  setStatus({ loaded: false, error: '' });
  rebuild();
  if (!store.user) { unsubs = []; return; }

  const opts = { includeMetadataChanges: true };
  const onErr = (e) => setStatus({ error: describe(e) });
  const arrived = (name, snap) => {
    raw.got.add(name);
    setStatus({ loaded: raw.got.size >= 3, fromCache: snap.metadata.fromCache, loadedAt: Date.now() });
  };
  unsubs = [
    onSnapshot(ref.items(), opts, (snap) => {
      raw.items = snap.docs.map((d) => ({ ...d.data(), id: d.id }))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name)));
      raw.pend.items = snap.docs.filter((d) => d.metadata.hasPendingWrites).length;
      arrived('items', snap); rebuild();
    }, onErr),
    onSnapshot(ref.notes(), opts, (snap) => {
      raw.notes = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      raw.pend.notes = snap.docs.filter((d) => d.metadata.hasPendingWrites).length;
      arrived('notes', snap); rebuild();
    }, onErr),
    onSnapshot(ref.meta('collection'), opts, (snap) => {
      raw.meta = snap.data() || {};
      raw.pend.meta = snap.metadata.hasPendingWrites ? 1 : 0;
      arrived('meta', snap); rebuild();
    }, onErr),
    onSnapshot(ref.meta('settings'), (snap) => {
      const s = snap.data();
      if (s) saveSettings({ geminiKey: s.geminiKey || '', model: s.model || settings.model });
    }, onErr),
  ];
}

/** Start auth. Fires 'status' when the signed-in state is known. */
export function load() {
  if (!configured) { setStatus({ authReady: true, error: 'Firebase isn’t set up yet: add your config to js/firebase-config.js.' }); return; }
  if (load.started) return;
  load.started = true;
  getRedirectResult(auth).catch((e) => setStatus({ error: describe(e) }));
  onAuthStateChanged(auth, (user) => {
    store.user = user;
    setStatus({ authReady: true });
    listen();
  });
}

export async function signIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported'].includes(e.code)) {
      return signInWithRedirect(auth, provider);
    }
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    throw e;
  }
}
export const signInWithPassword = (email, password) => signInWithEmailAndPassword(auth, email, password);
export const signOut = () => fbSignOut(auth);

/** Add (or change) a password on the signed-in account, for devices where Google sign-in doesn't work. */
export async function setAppPassword(password) {
  const user = auth.currentUser;
  if (user.providerData.some((p) => p.providerId === 'password')) return updatePassword(user, password);
  return linkWithCredential(user, EmailAuthProvider.credential(user.email, password));
}
export const hasPassword = () => Boolean(store.user?.providerData.some((p) => p.providerId === 'password'));

// Firestore write promises resolve only once the server confirms. Offline they stay pending
// (and are persisted), so track them for the status pill and surface real failures.
function track(p) {
  setStatus({ writing: store.status.writing + 1 });
  p.then(() => setStatus({ writing: store.status.writing - 1, error: '', lastSync: nowIso() }),
    (e) => setStatus({ writing: store.status.writing - 1, error: describe(e) }));
}

/** Apply a change: file 'collection' | 'notes'; op {t:'add', item, index?} | {t:'update', id, patch} | {t:'delete', id} | {t:'meta', patch}. */
export async function mutate(file, op) {
  if (!store.user) throw new Error('Sign in first.');
  const kind = file === 'collection' ? 'items' : 'notes';
  const list = file === 'collection' ? raw.items : raw.notes;
  const col = ref[kind]();
  if (op.t === 'add') {
    const item = { ...op.item };
    if (file === 'collection' && typeof item.order !== 'number') item.order = orderFor(list, op.index);
    delete item.id;
    track(setDoc(doc(col, op.item.id), item));
  } else if (op.t === 'update') {
    track(updateDoc(doc(col, op.id), op.patch));
  } else if (op.t === 'delete') {
    track(deleteDoc(doc(col, op.id)));
  } else if (op.t === 'meta') {
    track(setDoc(ref.meta('collection'), op.patch, { merge: true }));
    return;
  }
  if (file === 'collection') track(setDoc(ref.meta('collection'), { updated: today() }, { merge: true }));
}

function orderFor(list, index) {
  const orders = list.map((x) => x.order ?? 0);
  if (!Number.isInteger(index) || index >= list.length) return (orders.length ? Math.max(...orders) : 0) + 1;
  const after = orders[index];
  const before = index > 0 ? orders[index - 1] : after - 2;
  return (before + after) / 2;
}

/** Save a photo (resized JPEG blob) under `path`. Call before the mutate() that references it. */
export async function addPhoto(path, blob) {
  if (blob.size > 900 * 1024) throw new Error('Photo is too large (max ~900 KB after resizing).');
  photoUrls.set(path, URL.createObjectURL(blob));
  const data = Bytes.fromUint8Array(new Uint8Array(await blob.arrayBuffer()));
  track(setDoc(ref.photo(path), { data, type: blob.type || 'image/jpeg', created: nowIso() }));
}

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/** Sync URL for an <img>. Returns a placeholder and re-renders once the photo has loaded. */
export function photoUrl(path) {
  if (!path) return '';
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  if (photoUrls.has(path)) return photoUrls.get(path);
  photoUrlAsync(path).then((u) => { if (u) emit('change'); }, () => {});
  return BLANK;
}

export async function photoUrlAsync(path) {
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  if (photoUrls.has(path)) return photoUrls.get(path);
  if (!store.user) return '';
  if (!photoLoading.has(path)) {
    photoLoading.set(path, (async () => {
      const snap = await getDoc(ref.photo(path));
      if (!snap.exists()) return '';
      const { data, type } = snap.data();
      const url = URL.createObjectURL(new Blob([data.toUint8Array()], { type: type || 'image/jpeg' }));
      photoUrls.set(path, url);
      return url;
    })().finally(() => photoLoading.delete(path)));
  }
  return photoLoading.get(path);
}

export async function photoBlob(path) {
  const url = await photoUrlAsync(path);
  if (!url) throw new Error('Photo not available');
  return (await fetch(url)).blob();
}

/** Import an exported collection JSON ({meta, items}) or a plain item array. Replaces items with the same id. */
export async function importCollection(json) {
  const itemsIn = Array.isArray(json) ? json : json.items;
  if (!Array.isArray(itemsIn) || !itemsIn.every((x) => x && x.id && x.name)) throw new Error('That file doesn’t look like an Eevee Tracker export.');
  const base = raw.items.length ? Math.max(...raw.items.map((x) => x.order ?? 0)) + 1 : 0;
  const ops = itemsIn.map((it, i) => (b) => {
    const { id, ...rest } = it;
    b.set(doc(ref.items(), id), { ...rest, order: typeof it.order === 'number' ? it.order : base + i });
  });
  if (!Array.isArray(json) && json.meta) ops.push((b) => b.set(ref.meta('collection'), { ...json.meta, updated: today() }, { merge: true }));
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach((f) => f(b));
    track(b.commit());
  }
  return itemsIn.length;
}

/** Save the Gemini key/model to the account so every signed-in device gets it. */
export function saveAccountSettings(patch) {
  saveSettings(patch);
  if (store.user) track(setDoc(ref.meta('settings'), patch, { merge: true }));
}

export function describe(e) {
  const code = e?.code || '';
  if (code === 'permission-denied') return 'Firestore refused access. Check the security rules (see README).';
  if (code === 'unavailable' || !navigator.onLine) return 'Offline. Changes will sync when you’re back online.';
  if (code === 'auth/unauthorized-domain') return `This site isn’t allowed to sign in yet. Add ${location.hostname} under Firebase → Authentication → Settings → Authorized domains.`;
  if (code === 'auth/operation-not-allowed') return 'That sign-in method isn’t turned on in Firebase → Authentication → Sign-in method.';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') return 'Wrong email or password.';
  if (code === 'auth/requires-recent-login') return 'For security, sign out and back in with Google, then set the password again.';
  if (code === 'auth/weak-password') return 'Password must be at least 6 characters.';
  if (code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use') return 'That email already has a separate password account. Sign in with it instead.';
  return e?.message || String(e);
}

addEventListener('online', () => setStatus({ offline: false }));
addEventListener('offline', () => setStatus({ offline: true }));
