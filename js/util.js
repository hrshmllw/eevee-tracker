export const STATUSES = ['owned', 'ordered', 'wishlist'];
export const STATUS_LABEL = { owned: 'Owned', ordered: 'Incoming', wishlist: 'Wishlist' };
export const STATUS_LONG = { owned: 'Owned', ordered: 'Incoming / Ordered', wishlist: 'Wishlist' };

export const today = () => new Date().toISOString().slice(0, 10);
export const nowIso = () => new Date().toISOString();

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function slugify(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
}
export function uniqueId(base, taken) {
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/* ---------- fuzzy matching ---------- */
const STOP = new Set(['eevee', 'pokemon', 'figure', 'figures', 'the', 'a', 'an', 'of', 'with', 'series', 'set', 'and', 'eevee\'s', 'toy', 'collection', 'vol', 'no']);
export const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function tokens(s, aliases = {}) {
  let t = norm(s);
  for (const [k, v] of Object.entries(aliases)) if (t.includes(norm(k))) t += ' ' + norm(v);
  return new Set(t.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w)));
}

export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  let score = (2 * inter) / (a.size + b.size);
  const numsA = [...a].filter((w) => /\d/.test(w));
  const numsB = [...b].filter((w) => /\d/.test(w));
  if (numsA.length && numsB.length && !numsA.some((n) => b.has(n))) score *= 0.5;
  // containment bonus: every query word is in the item
  if (inter === a.size || inter === b.size) score = Math.min(1, score + 0.15);
  return score;
}

export function findMatches(query, items, aliases, { min = 0.4, limit = 5 } = {}) {
  const q = tokens(query, aliases);
  return items
    .map((item) => ({ item, score: similarity(q, tokens(`${item.name} ${item.brand} ${item.series || ''}`, aliases)) }))
    .filter((m) => m.score >= min)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

/* ---------- base64 ---------- */
export function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
export function blobToB64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

/* ---------- images ---------- */
export async function resizeImage(file, max = 800, quality = 0.82) {
  let src, w, h;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = src.width; h = src.height;
  } catch {
    src = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  return blob;
}

/* ---------- markdown export (same layout as the original list) ---------- */
export function exportMarkdown(col) {
  const items = col.items;
  const by = (s) => items.filter((i) => i.status === s);
  const owned = by('owned'), ordered = by('ordered'), wish = by('wishlist');
  const meta = col.meta || {};
  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const table = (totalLabel) => [
    '  Status                  Count',
    '  -------------------- --------',
    `  Owned                ${String(owned.length).padStart(8)}`,
    `  Incoming / Ordered   ${String(ordered.length).padStart(8)}`,
    `  Wishlist             ${String(wish.length).padStart(8)}`,
    `  **${totalLabel}**${' '.repeat(Math.max(1, 19 - totalLabel.length))}${String(`**${items.length}**`).padStart(8)}`,
  ].join('\n');

  const entry = (n, it) => {
    const out = [`${n}.  **${it.name}**`];
    const notes = [...(it.notes || [])];
    for (const l of it.links || []) notes.push(`[${l.label || l.url}](${l.url})`);
    for (const note of notes) out.push(`    -   ${note}`);
    return out.join('\n');
  };

  const parts = [
    `# ${meta.title || 'Eevee Figure Collection'}`, '',
    `**Last updated:** ${date}\\`, `**Total tracked entries:** ${items.length}`, '',
    table('Total'), '', '-'.repeat(72), '',
    `## Owned (${owned.length})`, '', owned.map((it, i) => entry(i + 1, it)).join('\n'), '',
    `## Incoming / Ordered (${ordered.length})`, '', ordered.map((it, i) => entry(i + 1, it)).join('\n'), '',
    `## Wishlist (${wish.length})`, '',
  ];
  const order = [...(meta.groupOrder || [])];
  for (const it of wish) if (!order.includes(it.group || 'Other brands / series')) order.push(it.group || 'Other brands / series');
  let n = 0;
  for (const g of order) {
    const list = wish.filter((it) => (it.group || 'Other brands / series') === g);
    if (!list.length) continue;
    parts.push(`### ${g}`, '', list.map((it) => entry(++n, it)).join('\n'), '');
    if (meta.sectionNotes?.[g]) parts.push(`*${meta.sectionNotes[g]}*`, '');
  }
  parts.push('-'.repeat(72), '', '## Tracker notes', '');
  for (const t of meta.trackerNotes || []) parts.push(`-   ${t}`);
  parts.push('', '## Collection totals by status', '', table('Grand total'), '');
  return parts.join('\n');
}

export function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
