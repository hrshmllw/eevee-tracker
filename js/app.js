import { store, load, mutate, addPhoto, photoUrl, photoBlob, flush } from './store.js';
import { settings, saveSettings, makeSetupCode, applySetupCode, DEFAULT_MODEL } from './settings.js';
import { gh } from './github.js';
import { localPass, askGemini, listModels } from './agent.js';
import {
  STATUSES, STATUS_LABEL, STATUS_LONG, esc, slugify, uniqueId, norm, findMatches,
  resizeImage, blobToB64, exportMarkdown, download, today, nowIso, debounce,
} from './util.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ---------- UI state (per device) ---------- */
const UI_KEY = 'eevee-tracker:ui';
const ui = { filter: 'all', groupBy: 'status', sort: 'list' };
try { Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch { /* ignore */ }
ui.q = '';
const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify({ filter: ui.filter, groupBy: ui.groupBy, sort: ui.sort })); } catch { /* ignore */ } };

const col = () => store.data.collection;
const items = () => col().items || [];
const notes = () => store.data.notes.notes || [];
const aliases = () => col().meta?.aliases || {};
const findItem = (id) => items().find((i) => i.id === id);
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');

const ICON = {
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  verify: '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/></svg>',
};
const VBADGE = {
  verified: '✓ Verified', likely: '≈ Likely real', provisional: '? Provisional', not_found: '! Unverified',
};
const VERDICT = { confirmed: '✓ Confirmed', likely: '≈ Likely', not_found: '✕ Not found' };
const VERDICT_CLASS = { confirmed: 'verified', likely: 'likely', not_found: 'not_found' };

/* ---------- toasts ---------- */
function toast(msg, action, ms = 5000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.onclick = () => { el.remove(); action.fn(); };
    el.append(b);
  }
  $('#toasts').append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

/* ---------- rendering ---------- */
function render() {
  renderStats();
  renderChips();
  if (ui.filter === 'notes') renderNotes(); else renderItems();
  fillDatalists();
}

function counts() {
  const c = { owned: 0, ordered: 0, wishlist: 0 };
  for (const i of items()) c[i.status] = (c[i.status] || 0) + 1;
  return c;
}

function renderStats() {
  const c = counts();
  const tiles = [['owned', 'Owned', c.owned], ['ordered', 'Incoming', c.ordered], ['wishlist', 'Wishlist', c.wishlist], ['all', 'Total', items().length]];
  $('#stats').innerHTML = tiles.map(([k, label, n]) =>
    `<button class="stat" type="button" data-k="${k}" aria-pressed="${ui.filter === k}"><b>${n}</b><span>${label}</span></button>`).join('');
}

function renderChips() {
  const c = counts();
  const pendingNotes = notes().filter((n) => n.status !== 'done').length;
  const chips = [['all', 'All', items().length], ['owned', 'Owned', c.owned], ['ordered', 'Incoming', c.ordered], ['wishlist', 'Wishlist', c.wishlist], ['notes', 'Notes', pendingNotes]];
  $('#chips').innerHTML = chips.map(([k, label, n]) =>
    `<button class="chip" type="button" data-f="${k}" aria-pressed="${ui.filter === k}">${label}<span class="n">${n}</span></button>`).join('');
  $('#groupBy').value = ui.groupBy;
  $('#sort').value = ui.sort;
  $('#groupBy').disabled = $('#sort').disabled = ui.filter === 'notes';
}

function matchesQuery(it) {
  if (!ui.q) return true;
  const hay = norm([it.name, it.brand, it.series, it.group, it.price, ...(it.notes || [])].join(' '));
  return norm(ui.q).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function renderItems() {
  let list = items().map((it, idx) => ({ it, idx }));
  if (STATUSES.includes(ui.filter)) list = list.filter(({ it }) => it.status === ui.filter);
  list = list.filter(({ it }) => matchesQuery(it));
  if (ui.sort === 'name') list.sort((a, b) => a.it.name.localeCompare(b.it.name));
  else if (ui.sort === 'recent') list.sort((a, b) => String(b.it.statusChanged || b.it.added || '').localeCompare(String(a.it.statusChanged || a.it.added || '')) || b.idx - a.idx);

  const groups = new Map();
  const key = (it) => (ui.groupBy === 'status' ? it.status : ui.groupBy === 'brand' ? it.brand || 'Unknown brand' : '');
  if (ui.groupBy === 'status') for (const s of STATUSES) groups.set(s, []);
  for (const x of list) {
    const k = key(x.it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x.it);
  }
  let keys = [...groups.keys()].filter((k) => groups.get(k).length);
  if (ui.groupBy === 'brand') keys.sort((a, b) => a.localeCompare(b));

  if (!list.length) {
    $('#list').innerHTML = `<p class="empty">${ui.q ? `Nothing matches “${esc(ui.q)}”.` : 'Nothing here yet.'}<br>
      <button class="btn small" type="button" data-act="ask-search">Ask the assistant</button></p>`;
    return;
  }
  const html = keys.map((k) => {
    const title = ui.groupBy === 'status' ? STATUS_LONG[k] : k;
    const head = ui.groupBy === 'none' ? '' : `<h2 class="group-h">${esc(title)} <span class="n">${groups.get(k).length}</span></h2>`;
    return `${head}<div class="cards">${groups.get(k).map(card).join('')}</div>`;
  }).join('');

  const meta = col().meta || {};
  const extra = (ui.filter === 'all' && !ui.q && (meta.trackerNotes?.length || Object.keys(meta.sectionNotes || {}).length))
    ? `<details class="tracker-notes card nophoto" style="margin-top:18px"><summary><b>Tracker notes</b></summary>
        <ul class="notes">${(meta.trackerNotes || []).map((n) => `<li>${esc(n)}</li>`).join('')}
        ${Object.entries(meta.sectionNotes || {}).map(([g, n]) => `<li><b>${esc(g)}:</b> ${esc(n)}</li>`).join('')}</ul></details>`
    : '';
  $('#list').innerHTML = html + extra;
}

function card(it) {
  const ph = it.photos?.[0];
  const v = it.verification?.status;
  const badge = VBADGE[v]
    ? `<span class="pill ${v}" title="${esc(it.verification?.evidence || (it.verification?.checkedAt ? 'Checked ' + it.verification.checkedAt.slice(0, 10) : ''))}">${VBADGE[v]}</span>` : '';
  const statusPill = ui.groupBy !== 'status' ? `<span class="pill ${it.status}">${STATUS_LABEL[it.status]}</span>` : '';
  const metaBits = [it.brand, it.series, it.price].filter(Boolean).map(esc).join(' · ');
  const n = it.notes || [];
  const notesHtml = !n.length ? '' : n.length > 3
    ? `<details><summary>${n.length} notes</summary><ul class="notes">${n.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>`
    : `<ul class="notes">${n.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const links = (it.links || []).length
    ? `<div class="links">${it.links.map((l) => `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label || l.url)}</a>`).join('')}</div>` : '';
  const src = it.verification?.sources || [];
  const sources = src.length
    ? `<details><summary>Sources (${src.length})</summary><ol class="notes">${src.map((s) => `<li><a href="${esc(safeUrl(s.uri))}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('')}</ol>${it.verification?.evidence ? `<p class="hint">${esc(it.verification.evidence)}</p>` : ''}</details>` : '';
  const primary = it.status === 'ordered'
    ? `<button class="btn small" type="button" data-act="move" data-to="owned">Arrived</button>`
    : it.status === 'wishlist' ? `<button class="btn small" type="button" data-act="move" data-to="ordered">Ordered</button>` : '';
  return `<article class="card${ph ? '' : ' nophoto'}" data-id="${esc(it.id)}">
    ${ph ? `<button class="thumb" type="button" data-act="photo" aria-label="View photos"><img src="${esc(photoUrl(ph))}" alt="" loading="lazy" decoding="async"></button>` : ''}
    <h3>${esc(it.name)}</h3>
    <p class="meta">${statusPill}${badge}<span>${metaBits}</span></p>
    <div class="rest">${notesHtml}${links}${sources}</div>
    <div class="actions">${primary}<span class="spacer"></span>
      <button class="icon-btn" type="button" data-act="verify" aria-label="Check with AI" title="Check with AI">${ICON.verify}</button>
      <button class="icon-btn" type="button" data-act="edit" aria-label="Edit" title="Edit">${ICON.edit}</button>
      <button class="icon-btn" type="button" data-act="delete" aria-label="Delete" title="Delete">${ICON.trash}</button>
    </div>
  </article>`;
}

const INTENT_LABEL = { add: 'Add', ordered: 'Ordered', arrived: 'Arrived', check: 'Check later', other: 'Other' };

function noteMoveSuggestion(n) {
  const to = n.intent === 'arrived' ? 'owned' : n.intent === 'ordered' ? 'ordered' : null;
  if (!to || !n.text) return null;
  const pool = items().filter((i) => (to === 'owned' ? i.status !== 'owned' : i.status === 'wishlist'));
  const m = findMatches(n.text, pool, aliases(), { min: 0.45, limit: 1 })[0];
  return m ? { item: m.item, to } : null;
}

function noteCard(n) {
  const first = (n.text || '').split('\n')[0] || (n.photo ? 'Photo note' : n.link || 'Note');
  const restText = (n.text || '').split('\n').slice(1).join('\n').trim();
  const sug = n.status !== 'done' ? noteMoveSuggestion(n) : null;
  const date = new Date(n.created).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const doneItem = n.itemId ? findItem(n.itemId) : null;
  return `<article class="card${n.photo ? '' : ' nophoto'}" data-note="${esc(n.id)}">
    ${n.photo ? `<button class="thumb" type="button" data-act="note-photo" aria-label="View photo"><img src="${esc(photoUrl(n.photo))}" alt="" loading="lazy"></button>` : ''}
    <h3>${esc(first)}</h3>
    <p class="meta"><span class="pill tag">${esc(INTENT_LABEL[n.intent] || 'Note')}</span><span>${esc(date)}</span>
      ${n.status === 'done' ? `<span class="pill owned">Done${doneItem ? ': ' + esc(doneItem.name) : ''}</span>` : ''}</p>
    <div class="rest">${restText ? `<p class="hint" style="white-space:pre-wrap">${esc(restText)}</p>` : ''}
      ${n.link ? `<div class="links"><a href="${esc(safeUrl(n.link))}" target="_blank" rel="noopener">${esc(n.link)}</a></div>` : ''}</div>
    <div class="actions">
      ${n.status !== 'done' ? `
        ${sug ? `<button class="btn small" type="button" data-act="note-move" data-id="${esc(sug.item.id)}" data-to="${sug.to}">Mark “${esc(sug.item.name)}” ${STATUS_LABEL[sug.to]}</button>` : ''}
        <button class="btn small primary" type="button" data-act="note-ai">Process with AI</button>
        <button class="btn small" type="button" data-act="note-convert">Convert</button>
        <button class="btn small ghost" type="button" data-act="note-done">Done</button>` : `<button class="btn small ghost" type="button" data-act="note-reopen">Reopen</button>`}
      <span class="spacer"></span>
      <button class="icon-btn" type="button" data-act="note-delete" aria-label="Delete note" title="Delete">${ICON.trash}</button>
    </div>
  </article>`;
}

function renderNotes() {
  const all = [...notes()].sort((a, b) => String(b.created).localeCompare(String(a.created)));
  const q = norm(ui.q);
  const vis = q ? all.filter((n) => norm(`${n.text} ${n.link}`).includes(q)) : all;
  const pending = vis.filter((n) => n.status !== 'done');
  const done = vis.filter((n) => n.status === 'done');
  $('#list').innerHTML = `
    <div class="row wrap" style="margin:8px 0 12px">
      <button class="btn small" type="button" data-act="new-note">New note</button>
      ${pending.length > 1 ? `<button class="btn small primary" type="button" data-act="note-ai-all">Process all with AI (${pending.length})</button>` : ''}
    </div>
    ${pending.length ? `<div class="cards">${pending.map(noteCard).join('')}</div>`
      : '<p class="empty">No pending notes. When the AI is out of quota, tap <b>Note</b> to jot something down and process it later.</p>'}
    ${done.length ? `<details style="margin-top:18px"><summary class="group-h" style="display:list-item">Done <span class="n">${done.length}</span></summary><div class="cards">${done.map(noteCard).join('')}</div></details>` : ''}`;
}

function fillDatalists() {
  const brands = [...new Set(items().map((i) => i.brand).filter(Boolean))].sort();
  $('#brands').innerHTML = brands.map((b) => `<option value="${esc(b)}">`).join('');
  const groups = [...new Set([...(col().meta?.groupOrder || []), ...items().map((i) => i.group).filter(Boolean)])];
  $('#groups').innerHTML = groups.map((g) => `<option value="${esc(g)}">`).join('');
}

/* ---------- sync indicator + banner ---------- */
function renderSync() {
  const s = store.status;
  let state, label;
  if (!gh.canWrite) { state = s.pending ? 'pending' : 'readonly'; label = s.pending ? `${s.pending} saved on this device` : 'Read-only'; }
  else if (s.syncing) { state = 'syncing'; label = 'Syncing…'; }
  else if (s.offline) { state = 'offline'; label = s.pending ? `Offline · ${s.pending} waiting` : 'Offline'; }
  else if (s.error) { state = 'error'; label = s.pending ? `${s.pending} not synced` : 'Sync problem'; }
  else if (s.pending) { state = 'pending'; label = `${s.pending} waiting`; }
  else { state = 'ok'; label = s.source === 'github' ? 'Synced' : s.source === 'cache' ? 'Last sync' : 'Loaded'; }
  const b = $('#sync');
  b.dataset.state = state;
  $('.label', b).textContent = label;
  b.title = s.error || (s.lastSync ? `Last sync ${new Date(s.lastSync).toLocaleTimeString()}` : label);

  const banner = $('#banner');
  let msg = '', btn = '';
  if (!gh.canWrite) {
    msg = settings.ghToken ? 'Set the GitHub owner and repo in Settings to save changes.' : 'Viewing only. Add your GitHub token in Settings to save changes (anything you add now stays on this device until then).';
    btn = '<button class="btn small" type="button" data-open="settings">Settings</button>';
  } else if (s.error && !s.offline) {
    msg = s.error; btn = '<button class="btn small" type="button" data-act="retry">Retry</button>';
  } else if (s.offline || s.source === 'cache') {
    msg = 'Offline: showing your last synced list. Notes and changes will sync when you’re back online.';
  } else if (isIOS() && !isStandalone() && !settings.iosTipSeen) {
    msg = 'Tip: in Safari, tap Share → Add to Home Screen to install this app.';
    btn = '<button class="btn small" type="button" data-act="ios-tip-ok">Got it</button>';
  }
  banner.hidden = !msg;
  banner.innerHTML = msg ? `<span>${esc(msg)}</span>${btn}` : '';
}

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/* ---------- item actions ---------- */
function moveItem(id, to, { undo = true } = {}) {
  const it = findItem(id);
  if (!it || it.status === to) return;
  const from = it.status;
  mutate('collection', { t: 'update', id, patch: { status: to, statusChanged: today() } }, `${STATUS_LABEL[to]}: ${it.name}`);
  toast(`“${it.name}” → ${STATUS_LONG[to]}`, undo ? { label: 'Undo', fn: () => moveItem(id, from, { undo: false }) } : null);
}

function deleteItem(id) {
  const index = items().findIndex((i) => i.id === id);
  if (index === -1) return;
  const item = JSON.parse(JSON.stringify(items()[index]));
  mutate('collection', { t: 'delete', id }, `Remove: ${item.name}`);
  toast(`Deleted “${item.name}”`, { label: 'Undo', fn: () => mutate('collection', { t: 'add', item, index }, `Restore: ${item.name}`) }, 8000);
}

function guessGroup(brand) {
  const w = items().find((i) => i.status === 'wishlist' && i.brand === brand && i.group);
  if (w) return w.group;
  if ((col().meta?.groupOrder || []).includes(brand)) return brand;
  return 'Other brands / series';
}

/* ---------- photo viewer ---------- */
const viewer = { list: [], i: 0 };
function openViewer(paths, i = 0) {
  viewer.list = paths; viewer.i = i;
  showViewer();
  $('#dlg-photo').showModal();
}
function showViewer() {
  $('#viewer-img').src = photoUrl(viewer.list[viewer.i]);
  $('#viewer-count').textContent = viewer.list.length > 1 ? `${viewer.i + 1} / ${viewer.list.length}` : '';
  $('#viewer-prev').hidden = $('#viewer-next').hidden = viewer.list.length < 2;
}
$('#viewer-prev').onclick = () => { viewer.i = (viewer.i - 1 + viewer.list.length) % viewer.list.length; showViewer(); };
$('#viewer-next').onclick = () => { viewer.i = (viewer.i + 1) % viewer.list.length; showViewer(); };

/* ---------- item form ---------- */
let form = { editing: null, photos: [], noteId: null, verification: null };

function openItemForm(item = null, prefill = {}) {
  const f = $('#item-form');
  f.reset();
  const src = item || prefill;
  form = {
    editing: item?.id || null,
    photos: (src.photos || []).map((path) => ({ path })),
    noteId: prefill.noteId || null,
    verification: src.verification || null,
  };
  if (prefill.photoBlob) form.photos.push({ blob: prefill.photoBlob, url: URL.createObjectURL(prefill.photoBlob) });
  f.name.value = src.name || '';
  f.brand.value = src.brand || '';
  f.series.value = src.series || '';
  f.status.value = src.status || 'wishlist';
  f.price.value = src.price || '';
  f.group.value = src.group || '';
  f.notes.value = (src.notes || []).join('\n');
  f.links.value = (src.links || []).map((l) => (l.label && l.label !== l.url ? `${l.label} | ${l.url}` : l.url)).join('\n');
  $('#item-title').textContent = item ? 'Edit item' : 'Add item';
  const v = form.verification;
  $('#item-verif').textContent = v && v.status !== 'unchecked'
    ? `Check: ${VBADGE[v.status] || v.status}${v.checkedAt ? ' · ' + v.checkedAt.slice(0, 10) : ''}` : '';
  renderFormPhotos();
  $('#dlg-item').showModal();
  if (!item) f.name.focus();
}

function renderFormPhotos() {
  $('#item-photos').innerHTML = form.photos.map((p, i) => `<div class="ph">
      <img src="${esc(p.url || photoUrl(p.path))}" alt="">
      ${i ? `<button type="button" class="first" data-i="${i}" title="Make main photo" aria-label="Make main photo">★</button>` : ''}
      <button type="button" class="rm" data-i="${i}" aria-label="Remove photo">✕</button></div>`).join('');
}
$('#item-photos').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const i = Number(b.dataset.i);
  if (b.classList.contains('rm')) form.photos.splice(i, 1);
  else form.photos.unshift(...form.photos.splice(i, 1));
  renderFormPhotos();
});
$('#item-photo-input').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    try {
      const blob = await resizeImage(file);
      form.photos.push({ blob, url: URL.createObjectURL(blob) });
    } catch { toast('Couldn’t read that image.'); }
  }
  e.target.value = '';
  renderFormPhotos();
});

$('#item-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const name = f.name.value.trim();
  if (!name) { f.name.focus(); toast('Give it a name first.'); return; }
  const status = f.status.value;
  const brand = f.brand.value.trim();
  const id = form.editing || uniqueId(slugify(name), new Set(items().map((i) => i.id)));
  const photos = [];
  let n = 0;
  for (const p of form.photos) {
    if (p.path) { photos.push(p.path); continue; }
    const path = `data/photos/${id}-${Date.now().toString(36)}${n++}.jpg`;
    await addPhoto(path, p.blob);
    photos.push(path);
  }
  const links = f.links.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [a, b] = l.split(/\s+\|\s+/);
    const url = (b || a).trim();
    let label = b ? a.trim() : '';
    if (!label) { try { label = new URL(url).hostname.replace(/^www\./, ''); } catch { label = url; } }
    return { label, url };
  });
  const data = {
    name, brand, series: f.series.value.trim(), status, price: f.price.value.trim(),
    group: f.group.value.trim() || (status === 'wishlist' ? guessGroup(brand) : ''),
    notes: f.notes.value.split('\n').map((s) => s.trim()).filter(Boolean),
    links, photos,
  };
  if (form.editing) {
    const old = findItem(form.editing);
    if (old && old.status !== status) data.statusChanged = today();
    mutate('collection', { t: 'update', id, patch: data }, `Edit: ${name}`);
    toast('Saved');
  } else {
    const item = {
      id, ...data,
      verification: form.verification || { status: 'unchecked', sources: [], checkedAt: null },
      added: today(), statusChanged: today(),
    };
    mutate('collection', { t: 'add', item }, `Add: ${name} (${STATUS_LABEL[status]})`);
    toast(`Added to ${STATUS_LONG[status]}`);
  }
  if (form.noteId) markNote(form.noteId, { status: 'done', itemId: id, doneAt: nowIso() });
  $('#dlg-item').close();
});

/* ---------- notes ---------- */
let noteForm = { blob: null };
function openNoteForm({ text = '', link = '', blob = null, intent = 'add' } = {}) {
  const f = $('#note-form');
  f.reset();
  f.text.value = text;
  f.link.value = link;
  const r = f.querySelector(`input[name="intent"][value="${intent}"]`);
  if (r) r.checked = true;
  noteForm = { blob };
  renderNotePhoto();
  $('#dlg-note').showModal();
  f.text.focus();
}
function renderNotePhoto() {
  $('#note-photo').innerHTML = noteForm.blob
    ? `<div class="ph"><img src="${esc(URL.createObjectURL(noteForm.blob))}" alt=""><button type="button" class="rm" aria-label="Remove photo">✕</button></div>` : '';
}
$('#note-photo').addEventListener('click', (e) => { if (e.target.closest('.rm')) { noteForm.blob = null; renderNotePhoto(); } });
$('#note-photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { noteForm.blob = await resizeImage(file); renderNotePhoto(); } catch { toast('Couldn’t read that image.'); }
});
$('#note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const text = f.text.value.trim();
  const link = f.link.value.trim();
  if (!text && !link && !noteForm.blob) { toast('Write something or add a photo.'); return; }
  const id = 'n-' + Date.now().toString(36);
  let photo = null;
  if (noteForm.blob) { photo = `data/note-photos/${id}.jpg`; await addPhoto(photo, noteForm.blob); }
  const note = { id, created: nowIso(), text, link, intent: f.intent.value || 'add', photo, status: 'pending' };
  mutate('notes', { t: 'add', item: note }, `Note: ${(text || link || 'photo').slice(0, 50)}`);
  $('#dlg-note').close();
  toast(gh.canWrite && navigator.onLine ? 'Note saved' : 'Note saved on this device. It will sync later.', { label: 'View', fn: () => setFilter('notes') });
});

function markNote(id, patch) { mutate('notes', { t: 'update', id, patch }, patch.status === 'done' ? 'Note done' : 'Note updated'); }
function deleteNote(id) {
  const index = notes().findIndex((n) => n.id === id);
  if (index === -1) return;
  const item = JSON.parse(JSON.stringify(notes()[index]));
  mutate('notes', { t: 'delete', id }, 'Delete note');
  toast('Note deleted', { label: 'Undo', fn: () => mutate('notes', { t: 'add', item, index }, 'Restore note') }, 8000);
}

function convertNote(n) {
  const to = n.intent === 'arrived' ? 'owned' : n.intent === 'ordered' ? 'ordered' : 'wishlist';
  const lines = (n.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const pm = (n.text || '').match(/(?:[₱$¥€£]|\bPHP\s?|\bP(?=\d))\s?([\d,.]+)/i);
  const price = pm ? (/^[$¥€£]/.test(pm[0]) ? pm[0].replace(/\s/g, '') : `₱${pm[1]}`) : '';
  const hay = norm(n.text);
  const brand = [...new Set(items().map((i) => i.brand).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .find((b) => hay.includes(norm(b.replace(/\s*\(.*\)$/, '')))) || '';
  openItemForm(null, {
    name: lines[0] || '', notes: lines.slice(1), status: to, price, brand,
    links: n.link ? [{ label: (() => { try { return new URL(n.link).hostname.replace(/^www\./, ''); } catch { return n.link; } })(), url: n.link }] : [],
    photos: n.photo ? [n.photo] : [], noteId: n.id,
  });
}

const INTENT_HINT = { add: 'Found this, add it to my list.', ordered: 'I ordered this.', arrived: 'This arrived.', check: 'Is this real? Check it.', other: '' };
async function processNote(n) {
  let image = null;
  if (n.photo) { try { image = await photoBlob(n.photo); } catch { /* photo not reachable */ } }
  const text = [n.text, n.link, INTENT_HINT[n.intent]].filter(Boolean).join('\n');
  openAgent();
  return send({ text, image, noteId: n.id, notePhotoPath: n.photo || null });
}
async function processAllNotes() {
  const pending = notes().filter((n) => n.status !== 'done').sort((a, b) => String(a.created).localeCompare(String(b.created)));
  openAgent();
  for (const [i, n] of pending.entries()) {
    addMsg('sys', `Note ${i + 1} of ${pending.length}`);
    const r = await processNote(n);
    if (r === 'rate' || r === 'nokey' || r === 'auth') { addMsg('sys', 'Stopped. The remaining notes are still saved.'); break; }
  }
}

/* ---------- assistant ---------- */
const agent = { image: null, runs: new Map(), seq: 0 };
const log = $('#agent-log');

function openAgent(opts = {}) {
  const dlg = $('#dlg-agent');
  $('#agent-model').textContent = settings.geminiKey ? (settings.model || DEFAULT_MODEL) : 'no API key yet';
  if (!log.children.length) introAgent();
  if (!dlg.open) dlg.showModal();
  if (opts.text) $('#agent-input').value = opts.text;
  if (opts.image) setAttach(opts.image);
  autoGrow();
  if (opts.autoSend) send(opts);
  else if (!matchMedia('(pointer: coarse)').matches) $('#agent-input').focus();
}

function introAgent() {
  const ex = ['check for Funism', 'what Eevee figures does Re-Ment make?', 'is LDCX Blowing Light a real series?', 'MonColle Box Vol. 7 arrived'];
  addMsg('bot', `<p>Tell me what you found, ask about a brand, or attach a photo of a box or listing. I check the web before anything is added.</p>
    ${settings.geminiKey ? '' : '<p><b>Add your free Gemini API key in Settings first.</b> <button class="btn small" type="button" data-open="settings">Settings</button></p>'}
    <div class="examples">${ex.map((x) => `<button class="chip" type="button" data-example="${esc(x)}">${esc(x)}</button>`).join('')}</div>`);
}

function addMsg(kind, html) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.innerHTML = html;
  log.append(el);
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return el;
}

function setAttach(blob) {
  agent.image = blob;
  const box = $('#agent-attach');
  box.hidden = !blob;
  box.innerHTML = blob ? `<img src="${esc(URL.createObjectURL(blob))}" alt=""><span>Photo attached</span><button class="btn small ghost" type="button" data-act="unattach">Remove</button>` : '';
}

function autoGrow() {
  const t = $('#agent-input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight + 2, 140) + 'px';
}

async function send(opts = {}) {
  const input = $('#agent-input');
  const text = (opts.text ?? input.value).trim();
  const image = opts.image !== undefined ? opts.image : agent.image;
  if (!text && !image) return null;
  input.value = '';
  autoGrow();
  setAttach(null);
  const run = ++agent.seq;
  const ctx = { text, image, noteId: opts.noteId || null, notePhotoPath: opts.notePhotoPath || null, verifyId: opts.verifyId || null, added: new Set() };
  agent.runs.set(run, ctx);
  addMsg('user', `${esc(text).replace(/\n/g, '<br>')}${image ? `<img src="${esc(URL.createObjectURL(image))}" alt="">` : ''}`);

  if (!image && !opts.skipLocal && !opts.verifyId) {
    const lp = localPass(text, items(), aliases());
    if (lp?.kind === 'move') {
      addMsg('bot', `<p>That sounds like an update to something already on your list:</p>
        ${lp.items.map((it) => `<div class="cand"><h4>${esc(it.name)}</h4><p class="meta"><span class="pill ${it.status}">${STATUS_LABEL[it.status]}</span></p>
          <div class="acts"><button class="btn small primary" type="button" data-act="ag-move" data-run="${run}" data-id="${esc(it.id)}" data-to="${lp.to}">Mark as ${STATUS_LABEL[lp.to]}</button></div></div>`).join('')}
        <div class="acts" style="margin-top:8px"><button class="btn small ghost" type="button" data-act="ag-ask" data-run="${run}">Not it, ask AI</button></div>`);
      return 'local';
    }
    if (lp?.kind === 'matches') {
      addMsg('bot', `<p>Possibly already tracked: ${lp.items.map((it) => `<b>${esc(it.name)}</b> (${STATUS_LABEL[it.status]})`).join(', ')}. Checking the web anyway…</p>`);
    }
  }

  const typing = addMsg('bot', '<span class="typing">Searching the web</span>');
  try {
    const res = await askGemini({ text, image: image ? { mime: image.type || 'image/jpeg', b64: await blobToB64(image) } : null }, items(), aliases());
    ctx.res = res;
    typing.innerHTML = resultHtml(res, run, ctx);
    const sug = typing.querySelector('.suggest');
    if (sug && res.searchHtml) sug.attachShadow({ mode: 'open' }).innerHTML = res.searchHtml;
    typing.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return 'ok';
  } catch (e) {
    typing.className = 'msg bot err';
    typing.innerHTML = `<p>${esc(e.message)}</p>
      <div class="acts" style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn small" type="button" data-act="ag-note" data-run="${run}">Save as note instead</button>
        ${e.kind === 'nokey' || e.kind === 'auth' ? '<button class="btn small" type="button" data-open="settings">Settings</button>' : ''}
        ${e.kind === 'rate' || e.kind === 'network' ? `<button class="btn small ghost" type="button" data-act="ag-ask" data-run="${run}">Try again</button>` : ''}
      </div>`;
    return e.kind || 'error';
  }
}

function resultHtml(res, run, ctx) {
  const paras = res.reply ? res.reply.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') : '';
  const keepable = Boolean(ctx.image || ctx.notePhotoPath);
  const cands = res.candidates.map((c, i) => {
    const tracked = c.matchesId ? findItem(c.matchesId) : null;
    const verdict = `<span class="pill ${VERDICT_CLASS[c.verdict]}">${VERDICT[c.verdict]}</span>`;
    let acts;
    if (ctx.verifyId) {
      acts = `<button class="btn small primary" type="button" data-act="ag-verif" data-run="${run}" data-i="${i}" data-id="${esc(ctx.verifyId)}">Save result to item</button>`;
    } else if (tracked) {
      acts = `<span class="hint">Already in your list as <b>${esc(tracked.name)}</b> (${STATUS_LABEL[tracked.status]}).</span>
        <button class="btn small ghost" type="button" data-act="ag-verif" data-run="${run}" data-i="${i}" data-id="${esc(tracked.id)}">Save check to it</button>`;
    } else {
      acts = `<span class="hint">${c.verdict === 'not_found' ? 'Add anyway (unverified):' : 'Add to:'}</span>`
        + ['wishlist', 'ordered', 'owned'].map((s) =>
          `<button class="btn small${s === c.suggestedStatus && c.verdict !== 'not_found' ? ' primary' : ''}" type="button" data-act="ag-add" data-run="${run}" data-i="${i}" data-status="${s}">${STATUS_LABEL[s]}</button>`).join('')
        + `<button class="btn small ghost" type="button" data-act="ag-edit" data-run="${run}" data-i="${i}">Edit first</button>`;
    }
    return `<div class="cand" data-cand="${i}">
      <h4>${esc(c.name)}</h4>
      <p class="meta">${verdict}<span>${[c.brand, c.series, c.price].filter(Boolean).map(esc).join(' · ')}</span></p>
      ${c.evidence ? `<p class="ev">${esc(c.evidence)}</p>` : ''}
      <div class="acts">${acts}</div>
      ${keepable && !tracked && !ctx.verifyId ? `<label class="keep"><input type="checkbox" checked data-keep>Use the photo as the item photo</label>` : ''}
    </div>`;
  }).join('');
  const moves = res.moves.map((m) => {
    const it = findItem(m.id);
    return it && it.status !== m.to ? `<div class="cand"><h4>${esc(it.name)}</h4><p class="meta"><span class="pill ${it.status}">${STATUS_LABEL[it.status]}</span> → <span class="pill ${m.to}">${STATUS_LABEL[m.to]}</span></p>
      <div class="acts"><button class="btn small primary" type="button" data-act="ag-move" data-run="${run}" data-id="${esc(it.id)}" data-to="${m.to}">Confirm move</button></div></div>` : '';
  }).join('');
  const sources = res.sources.length
    ? `<div class="sources">Sources found (${res.sources.length}):<ol>${res.sources.slice(0, 10).map((s) => `<li><a href="${esc(safeUrl(s.uri))}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('')}</ol></div>`
    : '<p class="hint">No web results came back, so nothing here counts as confirmed.</p>';
  return `${paras}${cands}${moves}${sources}${res.searchHtml ? '<div class="suggest"></div>' : ''}`;
}

function verificationFrom(res, c) {
  return {
    status: c.verdict === 'confirmed' ? 'verified' : c.verdict,
    sources: res.sources.slice(0, 8), evidence: c.evidence, checkedAt: nowIso(), model: settings.model || DEFAULT_MODEL,
  };
}

async function addFromCandidate(run, i, status, keep, btn) {
  const ctx = agent.runs.get(run);
  const c = ctx?.res?.candidates[i];
  if (!c || ctx.added.has(i)) return;
  ctx.added.add(i);
  const id = uniqueId(slugify(c.name), new Set(items().map((x) => x.id)));
  let photos = [];
  if (keep && ctx.notePhotoPath) photos = [ctx.notePhotoPath];
  else if (keep && ctx.image) {
    const path = `data/photos/${id}-${Date.now().toString(36)}.jpg`;
    await addPhoto(path, ctx.image);
    photos = [path];
  }
  const item = {
    id, name: c.name, brand: c.brand, series: c.series, group: status === 'wishlist' ? guessGroup(c.brand) : '',
    status, price: c.price || '', notes: [], links: [], photos,
    verification: verificationFrom(ctx.res, c), added: today(), statusChanged: today(),
  };
  mutate('collection', { t: 'add', item }, `Add: ${c.name} (${STATUS_LABEL[status]})`);
  if (ctx.noteId) markNote(ctx.noteId, { status: 'done', itemId: id, doneAt: nowIso() });
  const box = btn.closest('.cand');
  box.querySelector('.acts').innerHTML = `<span class="pill ${status}">Added to ${STATUS_LABEL[status]} ✓</span>`;
  box.querySelector('.keep')?.remove();
  toast(`Added “${c.name}”`);
}

log.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.example) { send({ text: b.dataset.example }); return; }
  const run = Number(b.dataset.run);
  const ctx = agent.runs.get(run);
  const i = Number(b.dataset.i);
  switch (b.dataset.act) {
    case 'ag-add': addFromCandidate(run, i, b.dataset.status, Boolean(b.closest('.cand')?.querySelector('[data-keep]')?.checked), b); break;
    case 'ag-edit': {
      const c = ctx.res.candidates[i];
      const keep = b.closest('.cand')?.querySelector('[data-keep]')?.checked;
      $('#dlg-agent').close();
      openItemForm(null, {
        name: c.name, brand: c.brand, series: c.series, price: c.price, status: c.suggestedStatus,
        verification: verificationFrom(ctx.res, c), noteId: ctx.noteId,
        photos: keep && ctx.notePhotoPath ? [ctx.notePhotoPath] : [],
        photoBlob: keep && !ctx.notePhotoPath ? ctx.image : null,
      });
      break;
    }
    case 'ag-verif': {
      const c = ctx.res.candidates[i];
      const it = findItem(b.dataset.id);
      if (!it) return;
      mutate('collection', { t: 'update', id: it.id, patch: { verification: verificationFrom(ctx.res, c) } }, `Check: ${it.name}`);
      b.outerHTML = `<span class="pill ${VERDICT_CLASS[c.verdict]}">Saved to “${esc(it.name)}”</span>`;
      break;
    }
    case 'ag-move':
      moveItem(b.dataset.id, b.dataset.to);
      if (ctx?.noteId) markNote(ctx.noteId, { status: 'done', itemId: b.dataset.id, doneAt: nowIso() });
      b.outerHTML = `<span class="pill ${b.dataset.to}">Moved ✓</span>`;
      break;
    case 'ag-ask': send({ text: ctx.text, image: ctx.image, noteId: ctx.noteId, notePhotoPath: ctx.notePhotoPath, skipLocal: true }); break;
    case 'ag-note':
      if (ctx.noteId) { toast('That’s already a saved note.'); break; }
      $('#dlg-agent').close();
      openNoteForm({ text: ctx.text, blob: ctx.image, intent: /arriv|received/i.test(ctx.text) ? 'arrived' : /order|bought/i.test(ctx.text) ? 'ordered' : /check|real|exist/i.test(ctx.text) ? 'check' : 'add' });
      break;
    default: break;
  }
});

$('#agent-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('#agent-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('#agent-input').addEventListener('input', autoGrow);
$('#agent-input').addEventListener('paste', async (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) { e.preventDefault(); setAttach(await resizeImage(file)); }
});
$('#agent-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) { try { setAttach(await resizeImage(file)); } catch { toast('Couldn’t read that image.'); } }
});
$('#agent-attach').addEventListener('click', (e) => { if (e.target.closest('[data-act="unattach"]')) setAttach(null); });

/* ---------- settings ---------- */
function openSettings() {
  const f = $('#settings-form');
  for (const k of ['owner', 'repo', 'branch', 'ghToken', 'geminiKey', 'model']) f[k].value = settings[k] || '';
  if (!f.model.value) f.model.value = DEFAULT_MODEL;
  $('#test-gh-out').textContent = '';
  $('#models-out').textContent = '';
  $('#setup-code').value = '';
  $('#ios-tip').hidden = !(isIOS() && !isStandalone());
  $('#install-app').hidden = !deferredInstall;
  $('#dlg-settings').showModal();
}
function formSettings() {
  const f = $('#settings-form');
  return {
    owner: f.owner.value.trim(), repo: f.repo.value.trim(), branch: f.branch.value.trim() || 'main',
    ghToken: f.ghToken.value.trim(), geminiKey: f.geminiKey.value.trim(), model: f.model.value.trim() || DEFAULT_MODEL,
  };
}
$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const before = JSON.stringify([settings.owner, settings.repo, settings.branch, settings.ghToken]);
  saveSettings(formSettings());
  $('#dlg-settings').close();
  toast('Settings saved');
  if (before !== JSON.stringify([settings.owner, settings.repo, settings.branch, settings.ghToken])) load(); else flush();
  renderSync();
});
$('#test-gh').onclick = async () => {
  const out = $('#test-gh-out');
  const saved = { ...settings };
  Object.assign(settings, formSettings());
  out.textContent = 'Checking…';
  try {
    const r = await gh.checkAccess();
    out.textContent = r.push ? `✓ Can write to ${r.name}` : `Can read ${r.name} but NOT write. Give the token Contents: read & write.`;
  } catch (err) {
    out.textContent = err.status === 401 ? 'Token rejected.' : err.status === 404 ? 'Repo not found (or the token can’t see it).' : `Failed: ${err.message}`;
  } finally { Object.assign(settings, saved); }
};
$('#load-models').onclick = async () => {
  const out = $('#models-out');
  const key = $('#settings-form').geminiKey.value.trim();
  if (!key) { out.textContent = 'Enter the API key first.'; return; }
  out.textContent = 'Loading…';
  try {
    const models = await listModels(key);
    $('#models').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
    out.textContent = `✓ Key works. ${models.length} models available${models.includes(DEFAULT_MODEL) ? ` (includes ${DEFAULT_MODEL})` : ''}.`;
  } catch (err) { out.textContent = `Failed: ${err.message}`; }
};
$('#copy-setup').onclick = async () => {
  saveSettings(formSettings());
  const code = makeSetupCode();
  try { await navigator.clipboard.writeText(code); toast('Setup code copied'); }
  catch { $('#setup-code').value = code; $('#setup-code').select(); toast('Copy the code from the box'); }
};
$('#apply-setup').onclick = () => {
  try {
    applySetupCode($('#setup-code').value);
    const f = $('#settings-form');
    for (const k of ['owner', 'repo', 'branch', 'ghToken', 'geminiKey', 'model']) f[k].value = settings[k] || '';
    $('#setup-code').value = '';
    toast('Setup code applied');
    load();
  } catch { toast('That setup code isn’t valid.'); }
};
$('#reload-data').onclick = () => { load(); toast('Reloading…', null, 1500); };
$('#export-md').onclick = () => download(`eevee-figure-collection-${today()}.md`, exportMarkdown(col()), 'text/markdown');
$('#export-json').onclick = () => download(`eevee-collection-${today()}.json`, JSON.stringify(col(), null, 2), 'application/json');

/* ---------- install / service worker ---------- */
let deferredInstall = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; $('#install-app').hidden = false; });
$('#install-app').onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null;
  $('#install-app').hidden = true;
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => toast('A new version is ready.', { label: 'Reload', fn: () => w.postMessage('skipWaiting') }, 0);
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => { /* SW unsupported here (e.g. file://) */ });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
}

/* ---------- global events ---------- */
function setFilter(f) {
  ui.filter = f;
  saveUi();
  render();
  scrollTo({ top: 0 });
}

document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) { close.closest('dialog')?.close(); return; }
  const open = e.target.closest('[data-open="settings"]');
  if (open) { $$('dialog[open]').forEach((d) => d.close()); openSettings(); return; }
  if (e.target.matches('dialog.sheet, dialog.viewer')) e.target.close(); // backdrop click
});

$('#stats').addEventListener('click', (e) => {
  const b = e.target.closest('.stat');
  if (b) setFilter(ui.filter === b.dataset.k ? 'all' : b.dataset.k);
});
$('#chips').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (b) setFilter(b.dataset.f); });
$('#q').addEventListener('input', debounce((e) => { ui.q = e.target.value.trim(); render(); }, 120));
$('#groupBy').addEventListener('change', (e) => { ui.groupBy = e.target.value; saveUi(); render(); });
$('#sort').addEventListener('change', (e) => { ui.sort = e.target.value; saveUi(); render(); });
$('#btn-add').onclick = () => openItemForm();
$('#btn-note').onclick = () => openNoteForm();
$('#btn-ask').onclick = () => openAgent();
$('#btn-settings').onclick = openSettings;
$('#sync').onclick = () => {
  const s = store.status;
  if (!gh.canWrite) openSettings();
  else if (s.pending) flush();
  else { load(); toast('Refreshing…', null, 1500); }
};
$('#banner').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b?.dataset.act === 'retry') flush();
  if (b?.dataset.act === 'ios-tip-ok') { saveSettings({ iosTipSeen: true }); renderSync(); }
});

$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'ask-search') { openAgent({ text: ui.q ? `check for ${ui.q}` : '' }); return; }
  if (act === 'new-note') { openNoteForm(); return; }
  if (act === 'note-ai-all') { processAllNotes(); return; }
  const cardEl = b.closest('[data-id], [data-note]');
  if (!cardEl) return;
  if (cardEl.dataset.note) {
    const n = notes().find((x) => x.id === cardEl.dataset.note);
    if (!n) return;
    if (act === 'note-ai') processNote(n);
    else if (act === 'note-convert') convertNote(n);
    else if (act === 'note-done') { markNote(n.id, { status: 'done', doneAt: nowIso() }); toast('Marked done', { label: 'Undo', fn: () => markNote(n.id, { status: 'pending' }) }); }
    else if (act === 'note-reopen') markNote(n.id, { status: 'pending' });
    else if (act === 'note-delete') deleteNote(n.id);
    else if (act === 'note-photo') openViewer([n.photo]);
    else if (act === 'note-move') { moveItem(b.dataset.id, b.dataset.to); markNote(n.id, { status: 'done', itemId: b.dataset.id, doneAt: nowIso() }); }
    return;
  }
  const it = findItem(cardEl.dataset.id);
  if (!it) return;
  if (act === 'move') moveItem(it.id, b.dataset.to);
  else if (act === 'edit') openItemForm(it);
  else if (act === 'delete') deleteItem(it.id);
  else if (act === 'photo') openViewer(it.photos);
  else if (act === 'verify') openAgent({ text: `Is “${it.name}”${it.brand ? ` by ${it.brand}` : ''} a real Eevee product? Verify the exact name.`, autoSend: true, verifyId: it.id });
});

store.addEventListener('change', render);
store.addEventListener('status', renderSync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - store.status.loadedAt > 120000 && !store.status.pending) load();
});

render();
renderSync();
load();

// Home-screen shortcuts (manifest "shortcuts"): ?action=note | ask
const action = new URLSearchParams(location.search).get('action');
if (action) {
  history.replaceState(null, '', location.pathname);
  if (action === 'note') openNoteForm();
  if (action === 'ask') openAgent();
}
