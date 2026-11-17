// One-off: convert the collection Markdown into data/collection.json.
// Usage: node scripts/import-md.mjs <path-to-md> [out=data/collection.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [, , src, out = 'data/collection.json'] = process.argv;
if (!src) { console.error('Usage: node scripts/import-md.mjs <file.md> [out.json]'); process.exit(1); }

const md = readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
const lines = md.split('\n');

const BRANDS = [
  [/^Takara Tomy ARTS/i, 'Takara Tomy ARTS (TTARTS)'],
  [/^MonColle/i, 'Takara Tomy ARTS (TTARTS)', 'MonColle'],
  [/^Funism/i, 'Funism'],
  [/^Bandai Pokémon Plamo/i, 'Bandai', 'Pokémon Plamo Collection'],
  [/^Bandai/i, 'Bandai'],
  [/^Keeppley/i, 'Keeppley'],
  [/^Jazwares/i, 'Jazwares'],
  [/^Langbowang \/ Zinc\.cn/i, 'Langbowang / Zinc.cn'],
  [/^Langbowang \/ Holly Box/i, 'Langbowang / Holly Box'],
  [/^Langbowang/i, 'Langbowang'],
  [/^LEGO/i, 'LEGO'],
  [/^Sunny & Sandy/i, 'Sunny & Sandy'],
  [/^Holly Box/i, 'Holly Box'],
  [/^Pokémon TCG China/i, 'Pokémon TCG China'],
  [/^Wicked Cool Toys/i, 'Wicked Cool Toys'],
  [/^Blokees/i, 'Blokees'],
  [/^Master Kong/i, 'Master Kong (promo)'],
  [/^Re-Ment/i, 'Re-Ment'],
  [/^LDCX/i, 'LDCX'],
  [/^Sentinel/i, 'Sentinel'],
  [/^MegaHouse/i, 'MegaHouse'],
  [/^Pokémon Center/i, 'Pokémon Center'],
];
const brandOf = (name) => {
  for (const [re, brand, series = ''] of BRANDS) if (re.test(name)) return { brand, series };
  return { brand: name.split(/\s+/)[0], series: '' };
};
const PROVISIONAL = /provisional|uncertain|not been conclusively verified|not been independently verified/i;
const slug = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const clean = (s) => s.replace(/\\\|/g, '|').replace(/\\$/, '').replace(/\s+/g, ' ').trim();

const items = [];
const sectionNotes = {};
const trackerNotes = [];
const groupOrder = [];
let section = null; // owned | ordered | wishlist | tracker | null
let group = '';
let cur = null;      // current item
let titleOpen = false;
let curNote = null;  // array ref + index for continuation
let italic = null;   // collecting italic paragraph
let trackerCur = -1;

const finishItem = () => { cur = null; titleOpen = false; curNote = null; };

for (const raw of lines) {
  const line = raw.replace(/\s+$/, '');
  const h2 = line.match(/^##\s+(.*)/);
  const h3 = line.match(/^###\s+(.*)/);
  if (h2 && !h3) {
    finishItem();
    const t = h2[1].toLowerCase();
    section = t.startsWith('owned') ? 'owned' : t.startsWith('incoming') ? 'ordered'
      : t.startsWith('wishlist') ? 'wishlist' : t.startsWith('tracker notes') ? 'tracker' : null;
    group = '';
    continue;
  }
  if (h3) { finishItem(); group = clean(h3[1]); if (!groupOrder.includes(group)) groupOrder.push(group); continue; }
  if (!section) continue;

  if (section === 'tracker') {
    const b = line.match(/^-\s+(.*)/);
    if (b) { trackerNotes.push(clean(b[1])); trackerCur = trackerNotes.length - 1; }
    else if (line.trim() && trackerCur >= 0) trackerNotes[trackerCur] = clean(trackerNotes[trackerCur] + ' ' + line);
    else trackerCur = -1;
    continue;
  }

  // italic section note: *...* (possibly multi-line)
  if (italic !== null) {
    italic += ' ' + line.trim();
    if (/\*$/.test(line.trim())) { sectionNotes[group || section] = clean(italic.replace(/^\*|\*$/g, '')); italic = null; }
    continue;
  }
  if (/^\*[^*]/.test(line.trim())) {
    finishItem();
    const t = line.trim();
    if (/[^*]\*$/.test(t)) sectionNotes[group || section] = clean(t.replace(/^\*|\*$/g, ''));
    else italic = t;
    continue;
  }

  const start = line.match(/^\s*(\d+)\.\s+\*\*(.*)$/);
  if (start) {
    const name = start[2];
    const { brand, series } = brandOf(clean(name.replace(/\*\*.*$/, '')));
    cur = {
      id: '', name, brand, series, group: section === 'wishlist' ? group : '',
      status: section, price: '', notes: [], links: [], photos: [],
      verification: { status: 'unchecked', sources: [], checkedAt: null },
      added: null, statusChanged: null,
    };
    items.push(cur);
    titleOpen = !/\*\*/.test(name);
    if (!titleOpen) cur.name = clean(name.replace(/\*\*.*$/, ''));
    curNote = null;
    continue;
  }
  if (!cur) continue;
  if (titleOpen) {
    cur.name += ' ' + line.trim();
    if (/\*\*/.test(line)) { titleOpen = false; cur.name = clean(cur.name.replace(/\*\*.*$/, '')); }
    continue;
  }
  const bullet = line.match(/^\s+-\s+(.*)/);
  if (bullet) { cur.notes.push(bullet[1]); curNote = cur.notes.length - 1; continue; }
  if (line.trim() && curNote !== null) { cur.notes[curNote] += ' ' + line.trim(); continue; }
  if (!line.trim()) curNote = null;
}

// Post-process notes: links, price, provisional flag, ids
const ids = new Set();
for (const it of items) {
  it.notes = it.notes.map(clean).flatMap((n) => {
    const links = [...n.matchAll(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g)];
    for (const [, label, url] of links) it.links.push({ label: clean(label), url });
    const rest = n.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '').trim();
    return rest ? [rest.replace(/\*\*/g, '')] : [];
  });
  const price = it.notes.join(' ').match(/₱\s?[\d,]+/);
  if (price) it.price = price[0].replace(/\s/g, '');
  if (it.notes.some((n) => PROVISIONAL.test(n))) it.verification.status = 'provisional';
  let id = slug(it.name) || 'item', n = 2;
  while (ids.has(id)) id = `${slug(it.name)}-${n++}`;
  ids.add(id); it.id = id;
}

const updatedMatch = md.match(/\*\*Last updated:\*\*\s*([^\\\n]+)/);
const updated = updatedMatch ? new Date(updatedMatch[1].trim() + ' 12:00 UTC').toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
for (const it of items) it.added = updated;

const collection = {
  updated,
  meta: {
    title: 'Eevee Figure Collection',
    aliases: {
      TTARTS: 'Takara Tomy ARTS', 'T-ARTS': 'Takara Tomy ARTS', 'Takara Tomy': 'Takara Tomy ARTS',
      'Zinc.cn': 'Langbowang', 'Holly Box': 'Langbowang', '康师傅': 'Master Kong',
      PC: 'Pokémon Center', Rement: 'Re-Ment', 'Re Ment': 'Re-Ment', MonColle: 'Moncolle',
      '伊布': 'Eevee', 'イーブイ': 'Eevee',
    },
    groupOrder,
    sectionNotes,
    trackerNotes,
  },
  items,
};

const counts = items.reduce((a, i) => ((a[i.status] = (a[i.status] || 0) + 1), a), {});
writeFileSync(resolve(out), JSON.stringify(collection, null, 2) + '\n', 'utf8');
console.log(`Wrote ${items.length} items to ${out}`, counts);
