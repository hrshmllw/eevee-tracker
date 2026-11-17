// AI assistant: local matching first (free, instant), then
//   1. Gemini plans web searches from the text/photo,
//   2. Tavily runs them (and reads any links you pasted),
//   3. Gemini judges whether the brand / figure / series really exists, citing only those results.
// Sources shown to the user are always real search results, never links the model wrote.
import { settings, DEFAULT_MODEL } from './settings.js';
import { findMatches, STATUS_LABEL } from './util.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const TAVILY = 'https://api.tavily.com';

export class AgentError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; } // nokey | rate | auth | network | bad
}

const ARRIVED = /\b(arrived|arrive|received|got it|came in|came|delivered|in hand|picked up)\b/gi;
const ORDERED = /\b(ordered|bought|purchased|paid for|checked out|preordered|pre-ordered)\b/gi;
const FILLER = /\b(just|has|have|had|my|the|is|was|already|today|finally|it|i|mark|as|to)\b/gi;

/** Cheap, offline understanding of "X arrived" / "ordered X" and duplicate hints. */
export function localPass(text, items, aliases) {
  if (!text?.trim()) return null;
  const to = text.match(ARRIVED) ? 'owned' : text.match(ORDERED) ? 'ordered' : null;
  if (to) {
    const q = text.replace(ARRIVED, ' ').replace(ORDERED, ' ').replace(FILLER, ' ');
    const pool = items.filter((i) => (to === 'owned' ? i.status !== 'owned' : i.status === 'wishlist'));
    const m = findMatches(q, pool, aliases, { min: 0.45, limit: 3 });
    if (m.length === 1 || (m.length > 1 && m[0].score - m[1].score > 0.12)) return { kind: 'move', items: [m[0].item], to };
    if (m.length) return { kind: 'move', items: m.map((x) => x.item), to };
  }
  const d = findMatches(text, items, aliases, { min: 0.55, limit: 3 });
  return d.length ? { kind: 'matches', items: d.map((x) => x.item) } : null;
}

function context(items, aliases) {
  const list = items.map((i) => `- ${i.id} | ${i.name} | ${i.brand} | ${STATUS_LABEL[i.status]}`).join('\n');
  const al = Object.entries(aliases || {}).map(([k, v]) => `${k} = ${v}`).join('; ');
  return `You are the assistant inside a personal Eevee collectibles tracker (figures, blind boxes, building-block sets, plush-adjacent merch). The collector buys from Japanese, Chinese and Western brands, often through Taobao, Xianyu, Shopee, Mercari and Pokémon Center.

The collector's current list (id | name | brand | status):
${list}

Brand aliases: ${al}`;
}

const PLAN_PROMPT = `
STEP: plan web searches. Work out what the user wants and what to search for.
- "found this, add it" (text, link or photo) -> intent "add"
- "check for <brand>" / "what Eevee figures does <brand> make" -> intent "check_brand"
- "is <thing> real?" -> intent "check_item"
- "<item> arrived" / "I ordered <item>" -> intent "move" (no search needed: queries [])
- anything else -> intent "question"
For photos, read packaging text, logos, listing titles and prices to identify brand and series.
Give 1-3 short, specific web search queries that would find shop listings, official pages or collector posts for the product or brand. Include "Eevee". Add one Chinese (伊布 / 宝可梦) or Japanese (イーブイ) query when the brand is Chinese or Japanese.
Return JSON: {"intent": "...", "queries": ["..."], "identified": "what you think the item is, or empty"}`;

const JUDGE_PROMPT = `
STEP: answer using ONLY the numbered web results below as evidence. Never invent products, series names, brands or links.
Verdicts per candidate:
- "confirmed": at least one result clearly names this product (or, for a brand check, this product line) and it features Eevee. Cite it.
- "likely": the brand/line exists in the results and similar Eevee products exist, but the exact name or variant isn't shown.
- "not_found": the results don't support it. Say so plainly.
For "check_brand", list up to 12 distinct Eevee products from that brand that the results show.
If a candidate is the same product as an entry in the collector's list, set "matchesId" to that id. Use the collector's naming style: "<Brand> <Series/Product name>".
Return JSON:
{
  "intent": "add | check_brand | check_item | move | question",
  "reply": "1-3 short plain sentences for the collector",
  "candidates": [
    { "name": "", "brand": "", "series": "", "existsVerdict": "confirmed | likely | not_found",
      "evidence": "one sentence: what the cited results show", "sources": [1],
      "suggestedStatus": "wishlist | ordered | owned", "matchesId": null, "price": "" }
  ],
  "moves": [ { "id": "", "to": "owned | ordered | wishlist" } ]
}`;

function parseJson(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(raw); } catch { return null; }
}

async function gemini(system, parts) {
  const model = settings.model || DEFAULT_MODEL;
  let res;
  try {
    res = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    });
  } catch {
    throw new AgentError('network', 'Couldn’t reach Gemini. Check your connection.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || res.statusText;
    if (res.status === 429) throw new AgentError('rate', 'The free Gemini limit is used up for now. Try again later, or save this as a note.');
    if (res.status === 503) throw new AgentError('rate', 'Gemini is busy right now. Try again in a minute, or save this as a note.');
    if (res.status === 401 || res.status === 403 || /api key/i.test(msg)) throw new AgentError('auth', 'Gemini rejected the API key. Check it in Settings.');
    if (res.status === 404 && /model/i.test(msg)) throw new AgentError('bad', `Gemini model “${model}” isn’t available. Pick another in Settings → Load models.`);
    throw new AgentError('bad', `Gemini error: ${msg}`);
  }
  const out = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return parseJson(out) || {};
}

async function tavily(path, payload) {
  let res;
  try {
    res = await fetch(`${TAVILY}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.tavilyKey}` },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new AgentError('network', 'Couldn’t reach Tavily search. Check your connection.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.detail?.error || body?.error || res.statusText;
    if (res.status === 401 || res.status === 403) throw new AgentError('auth', 'Tavily rejected the search key. Check it in Settings.');
    if (res.status === 429 || res.status === 432 || res.status === 433) throw new AgentError('rate', 'The free Tavily search limit is used up for now (1,000 a month). Save this as a note and try later.');
    throw new AgentError('bad', `Search error: ${msg}`);
  }
  return body;
}

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

/** Run the planned searches (and read pasted links). Returns de-duplicated numbered results. */
async function search(queries, urls) {
  const jobs = queries.slice(0, 3).map((q) => tavily('search', { query: q, search_depth: 'basic', max_results: 5, include_answer: false }));
  if (urls.length) jobs.push(tavily('extract', { urls: urls.slice(0, 3) }).catch(() => ({ results: [] })));
  const settled = await Promise.allSettled(jobs);
  const fatal = settled.find((s) => s.status === 'rejected');
  const results = [];
  const seen = new Set();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const r of s.value.results || []) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      const text = String(r.content || r.raw_content || '').replace(/\s+/g, ' ').slice(0, r.raw_content ? 2500 : 700);
      results.push({ uri: r.url, title: r.title || hostname(r.url), text });
    }
  }
  if (!results.length && fatal) throw fatal.reason;
  return results.slice(0, 18);
}

const hostname = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

export async function askGemini({ text, image }, items, aliases) {
  if (!settings.geminiKey) throw new AgentError('nokey', 'Add your free Gemini API key in Settings to use the assistant.');
  if (!navigator.onLine) throw new AgentError('network', 'You’re offline.');
  const userText = text?.trim() || 'Identify this Eevee item and check it exists.';
  const userParts = [{ text: userText }];
  if (image) userParts.push({ inlineData: { mimeType: image.mime, data: image.b64 } });
  const ctx = context(items, aliases);

  // 1. plan
  const plan = await gemini(ctx + PLAN_PROMPT, userParts);
  const queries = (Array.isArray(plan.queries) ? plan.queries : []).map((q) => String(q).trim()).filter(Boolean);
  const urls = [...new Set(userText.match(URL_RE) || [])];

  // 2. search
  let results = [];
  let searchNote = '';
  if ((queries.length || urls.length) && plan.intent !== 'move') {
    if (settings.tavilyKey) results = await search(queries, urls);
    else searchNote = 'No search key yet, so nothing could be checked on the web. Add a free Tavily key in Settings.';
  }

  // 3. judge
  const evidence = results.length
    ? results.map((r, i) => `[${i + 1}] ${r.title}\n${r.uri}\n${r.text}`).join('\n\n')
    : '(no web results)';
  const judged = await gemini(`${ctx}\n${JUDGE_PROMPT}\n\nWeb results:\n${evidence}`, [
    ...userParts,
    ...(plan.identified ? [{ text: `(From the planning step: ${plan.identified})` }] : []),
  ]);

  const ids = new Set(items.map((i) => i.id));
  const cited = new Set();
  const candidates = (Array.isArray(judged.candidates) ? judged.candidates : []).map((c) => {
    const refs = (Array.isArray(c.sources) ? c.sources : []).map(Number).filter((n) => n >= 1 && n <= results.length);
    refs.forEach((n) => cited.add(n));
    let verdict = ['confirmed', 'likely', 'not_found'].includes(c.existsVerdict) ? c.existsVerdict : 'not_found';
    if (verdict === 'confirmed' && !refs.length) verdict = results.length ? 'likely' : 'not_found'; // must cite a real result
    if (verdict === 'likely' && !results.length) verdict = 'not_found';
    return {
      name: String(c.name || '').trim(), brand: String(c.brand || '').trim(), series: String(c.series || '').trim(),
      verdict, evidence: String(c.evidence || '').trim(), price: String(c.price || '').trim(),
      suggestedStatus: ['wishlist', 'ordered', 'owned'].includes(c.suggestedStatus) ? c.suggestedStatus : 'wishlist',
      matchesId: ids.has(c.matchesId) ? c.matchesId : null,
      sources: refs.map((n) => ({ uri: results[n - 1].uri, title: results[n - 1].title })),
    };
  }).filter((c) => c.name);

  const moves = (Array.isArray(judged.moves) ? judged.moves : [])
    .filter((m) => ids.has(m.id) && ['owned', 'ordered', 'wishlist'].includes(m.to));

  // Show the results the answer relied on first, then the rest of what came back.
  const order = [...cited, ...results.map((_, i) => i + 1).filter((n) => !cited.has(n))];
  const sources = order.map((n) => ({ uri: results[n - 1].uri, title: results[n - 1].title }));

  return {
    intent: judged.intent || plan.intent || 'question', reply: String(judged.reply || '').trim(),
    candidates, moves, sources, citedCount: cited.size, searchHtml: '', queries, searchNote,
    grounded: results.length > 0,
  };
}

export async function listModels(key = settings.geminiKey) {
  const res = await fetch(`${API}/models?pageSize=300`, { headers: { 'x-goog-api-key': key } });
  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || res.statusText);
  return (j.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(m.name)
      && !/(tts|image|audio|live|embedding|transcribe|robotics|computer-use|banana)/.test(m.name))
    .map((m) => m.name.replace(/^models\//, ''));
}

/** Check a Tavily key with one tiny search (uses 1 of the monthly free searches). */
export async function testTavily(key) {
  const saved = settings.tavilyKey;
  settings.tavilyKey = key;
  try { return (await tavily('search', { query: 'Eevee figure', max_results: 1 })).results?.length >= 0; }
  finally { settings.tavilyKey = saved; }
}
