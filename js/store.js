// Data layer: load from GitHub (or the site copy / last cache), apply changes optimistically,
// and push them to GitHub as commits through an IndexedDB outbox.
import { gh, rawUrl } from './github.js';
import { queue } from './queue.js';
import { settings } from './settings.js';
import { utf8ToB64, blobToB64, today, nowIso } from './util.js';

export const FILES = { collection: 'data/collection.json', notes: 'data/notes.json' };
const EMPTY = { collection: { updated: today(), meta: {}, items: [] }, notes: { notes: [] } };
const clone = (x) => JSON.parse(JSON.stringify(x));

export const store = new EventTarget();
store.data = { collection: clone(EMPTY.collection), notes: clone(EMPTY.notes) };
store.status = { source: '', syncing: false, error: '', offline: !navigator.onLine, pending: 0, loadedAt: 0 };
const base = { collection: clone(EMPTY.collection), notes: clone(EMPTY.notes) };
let pending = [];
const photoUrls = new Map();
let flushing = false, flushAgain = false;

const emit = (type) => store.dispatchEvent(new Event(type));
function setStatus(patch) {
  Object.assign(store.status, patch, { pending: pending.length });
  emit('status');
}

export function applyOp(doc, file, op) {
  const list = file === 'collection' ? (doc.items ||= []) : (doc.notes ||= []);
  const i = list.findIndex((x) => x.id === (op.id || op.item?.id));
  if (op.t === 'add') {
    if (i === -1) {
      if (Number.isInteger(op.index) && op.index >= 0 && op.index <= list.length) list.splice(op.index, 0, op.item);
      else list.push(op.item);
    }
  } else if (op.t === 'update' && i !== -1) {
    Object.assign(list[i], op.patch);
  } else if (op.t === 'delete' && i !== -1) {
    list.splice(i, 1);
  } else if (op.t === 'meta' && file === 'collection') {
    doc.meta = { ...(doc.meta || {}), ...op.patch };
  }
  if (file === 'collection') doc.updated = today();
}

function rebuild() {
  for (const f of Object.keys(FILES)) {
    const d = clone(base[f]);
    for (const r of pending) if (r.kind === 'json' && r.file === f) applyOp(d, f, r.op);
    store.data[f] = d;
  }
  setStatus({});
  emit('change');
}

async function fetchSite(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function load() {
  let source = '', error = '';
  if (gh.canRead && navigator.onLine) {
    try {
      for (const [f, path] of Object.entries(FILES)) {
        const r = await gh.getFile(path);
        base[f] = r ? JSON.parse(r.text) : clone(EMPTY[f]);
      }
      source = 'github';
    } catch (e) { error = describe(e); }
  }
  if (!source && gh.canRead) {
    const cached = await queue.kvGet('base').catch(() => null);
    if (cached) { Object.assign(base, cached); source = 'cache'; }
  }
  if (!source) {
    try {
      for (const [f, path] of Object.entries(FILES)) base[f] = (await fetchSite(path)) || clone(EMPTY[f]);
      source = 'site';
    } catch (e) {
      const cached = await queue.kvGet('base').catch(() => null);
      if (cached) { Object.assign(base, cached); source = 'cache'; } else error ||= 'Could not load the list. Check your connection.';
    }
  }
  if (source === 'github') await queue.kvSet('base', clone(base)).catch(() => {});

  pending = (await queue.all().catch(() => [])) || [];
  for (const r of pending) {
    if (r.kind === 'photo' && !photoUrls.has(r.path)) {
      const blob = await queue.getBlob(r.path).catch(() => null);
      if (blob) photoUrls.set(r.path, URL.createObjectURL(blob));
    }
  }
  setStatus({ source, error, loadedAt: Date.now() });
  rebuild();
  flush();
}

/** Queue a change to collection.json or notes.json and apply it locally right away. */
export async function mutate(file, op, msg = '') {
  const rec = { kind: 'json', file, op, msg };
  rec.seq = await queue.add(rec);
  pending.push(rec);
  rebuild();
  flush();
}

/** Queue a photo upload. Call before the mutate() that references the path. */
export async function addPhoto(path, blob) {
  photoUrls.set(path, URL.createObjectURL(blob));
  await queue.putBlob(path, blob);
  const rec = { kind: 'photo', path };
  rec.seq = await queue.add(rec);
  pending.push(rec);
  setStatus({});
  flush();
}

export function photoUrl(path) {
  if (!path) return '';
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  return photoUrls.get(path) || (settings.owner && settings.repo ? rawUrl(path) : path);
}

export async function photoBlob(path) {
  const local = await queue.getBlob(path).catch(() => null);
  if (local) return local;
  const res = await fetch(photoUrl(path));
  if (!res.ok) throw new Error('Photo not available offline');
  return res.blob();
}

export async function flush() {
  if (flushing) { flushAgain = true; return; }
  if (!pending.length) return setStatus({});
  if (!gh.canWrite) return setStatus({});
  if (!navigator.onLine) return setStatus({ offline: true });
  flushing = true;
  setStatus({ syncing: true });
  try {
    while (pending.length) {
      const head = pending[0];
      if (head.kind === 'photo') {
        const blob = await queue.getBlob(head.path);
        if (blob) {
          try {
            await gh.putFile(head.path, await blobToB64(blob), null, `Add photo ${head.path.split('/').pop()}`);
          } catch (e) { if (e.status !== 422) throw e; } // 422 = already uploaded
        }
        await queue.remove(head.seq);
        await queue.deleteBlob(head.path).catch(() => {});
        pending = pending.filter((r) => r !== head);
        continue;
      }
      const file = head.file;
      const batch = [];
      for (const r of pending) { if (r.kind === 'json' && r.file === file) batch.push(r); else break; }
      const msgs = [...new Set(batch.map((r) => r.msg).filter(Boolean))];
      const message = (msgs.slice(0, 3).join('; ') || `Update ${file}`) + (msgs.length > 3 ? ` (+${msgs.length - 3} more)` : '');
      for (let attempt = 0; ; attempt++) {
        const remote = await gh.getFile(FILES[file]);
        const doc = remote ? JSON.parse(remote.text) : clone(EMPTY[file]);
        for (const r of batch) applyOp(doc, file, r.op);
        try {
          await gh.putFile(FILES[file], utf8ToB64(JSON.stringify(doc, null, 2) + '\n'), remote?.sha, message);
          base[file] = doc;
          break;
        } catch (e) {
          if ((e.status === 409 || e.status === 422) && attempt < 3) continue; // someone else committed; retry on fresh copy
          throw e;
        }
      }
      for (const r of batch) await queue.remove(r.seq);
      pending = pending.filter((r) => !batch.includes(r));
    }
    await queue.kvSet('base', clone(base)).catch(() => {});
    setStatus({ error: '', offline: false, lastSync: nowIso() });
  } catch (e) {
    setStatus({ error: describe(e), offline: !navigator.onLine });
  } finally {
    flushing = false;
    setStatus({ syncing: false });
    rebuild();
    if (flushAgain) { flushAgain = false; flush(); }
  }
}

export function describe(e) {
  if (e?.status === 401) return 'GitHub token was rejected. Update it in Settings.';
  if (e?.status === 403) return 'GitHub token can’t write to this repo (needs Contents: read & write).';
  if (e?.status === 404) return 'Repo not found. Check owner/repo in Settings.';
  if (e instanceof TypeError || !navigator.onLine) return 'Offline. Changes will sync when you’re back online.';
  return e?.message || String(e);
}

addEventListener('online', () => { setStatus({ offline: false }); flush(); });
addEventListener('offline', () => setStatus({ offline: true }));
