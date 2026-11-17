// AI assistant: local matching first (free, instant), then Gemini + Google Search grounding
// to confirm that a brand / figure / series really exists.
import { settings, DEFAULT_MODEL } from './settings.js';
import { findMatches, STATUS_LABEL } from './util.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';

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

function systemPrompt(items, aliases) {
  const list = items.map((i) => `- ${i.id} | ${i.name} | ${i.brand} | ${STATUS_LABEL[i.status]}`).join('\n');
  const al = Object.entries(aliases || {}).map(([k, v]) => `${k} = ${v}`).join('; ');
  return `You are the assistant inside a personal Eevee collectibles tracker (figures, blind boxes, building-block sets, plush-adjacent merch). The collector buys from Japanese, Chinese and Western brands, often through Taobao, Xianyu, Shopee, Mercari and Pokémon Center.

Your main job is to CONFIRM THAT THINGS ARE REAL. Always use Google Search before answering. Search in English and, when useful, Chinese (伊布 = Eevee, 宝可梦 = Pokémon) and Japanese (イーブイ, ポケモン). Never invent products, series names or brands.

Commands you will get:
- "found this, add it" (text, link or photo of a box/listing) -> intent "add": identify the exact product and verify it exists.
- "check for <brand>" / "what Eevee figures does <brand> make" -> intent "check_brand": list up to 12 distinct Eevee products from that brand that you found evidence for.
- "is <thing> real?" -> intent "check_item".
- "<item> arrived" / "I ordered <item>" -> intent "move" with moves[].
- anything else -> intent "question".

Verdicts per candidate:
- "confirmed": an official page, retailer or marketplace listing, or reputable collector source clearly names this product and it features Eevee.
- "likely": the brand/line exists and similar Eevee products exist, but the exact name or variant is unclear.
- "not_found": no trustworthy evidence. Say so plainly.

For photos: read packaging text, logos, listing titles and prices to identify brand and series.

The collector's current list (id | name | brand | status):
${list}

Brand aliases: ${al}

If a candidate is the same product as an entry above, set "matchesId" to that id (do not suggest it as new). Use the collector's naming style: "<Brand> <Series/Product name>".

Reply with 1-3 short plain sentences, then exactly one JSON code block in this shape:
\`\`\`json
{
  "intent": "add | check_brand | check_item | move | question",
  "candidates": [
    { "name": "", "brand": "", "series": "", "existsVerdict": "confirmed | likely | not_found",
      "evidence": "one sentence: what you found and where", "suggestedStatus": "wishlist | ordered | owned", "matchesId": null, "price": "" }
  ],
  "moves": [ { "id": "", "to": "owned | ordered | wishlist" } ]
}
\`\`\``;
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(raw); } catch { return null; }
}

export async function askGemini({ text, image }, items, aliases) {
  if (!settings.geminiKey) throw new AgentError('nokey', 'Add your free Gemini API key in Settings to use the assistant.');
  if (!navigator.onLine) throw new AgentError('network', 'You’re offline.');
  const parts = [{ text: text?.trim() || 'Identify this Eevee item and check it exists.' }];
  if (image) parts.push({ inlineData: { mimeType: image.mime, data: image.b64 } });
  const model = settings.model || DEFAULT_MODEL;

  let res;
  try {
    res = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(items, aliases) }] },
        contents: [{ role: 'user', parts }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2 },
      }),
    });
  } catch {
    throw new AgentError('network', 'Couldn’t reach Gemini. Check your connection.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || res.statusText;
    if (res.status === 429) throw new AgentError('rate', 'The free Gemini limit is used up for now. Try again later, or save this as a note.');
    if (res.status === 401 || res.status === 403 || /api key/i.test(msg)) throw new AgentError('auth', 'Gemini rejected the API key. Check it in Settings.');
    throw new AgentError('bad', `Gemini error: ${msg}`);
  }

  const cand = body.candidates?.[0];
  const out = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  const gm = cand?.groundingMetadata || {};
  const seen = new Set();
  const sources = (gm.groundingChunks || [])
    .map((c) => c.web).filter((w) => w?.uri && !seen.has(w.uri) && seen.add(w.uri))
    .map((w) => ({ uri: w.uri, title: w.title || new URL(w.uri).hostname }));
  const json = extractJson(out) || {};
  const reply = out.replace(/```(?:json)?[\s\S]*?```/gi, '').trim() || (json.candidates?.length ? '' : out.trim());
  const ids = new Set(items.map((i) => i.id));

  const candidates = (Array.isArray(json.candidates) ? json.candidates : []).map((c) => {
    let verdict = ['confirmed', 'likely', 'not_found'].includes(c.existsVerdict) ? c.existsVerdict : 'not_found';
    if (verdict === 'confirmed' && !sources.length) verdict = 'likely'; // no real search hits -> can't call it confirmed
    return {
      name: String(c.name || '').trim(), brand: String(c.brand || '').trim(), series: String(c.series || '').trim(),
      verdict, evidence: String(c.evidence || '').trim(), price: String(c.price || '').trim(),
      suggestedStatus: ['wishlist', 'ordered', 'owned'].includes(c.suggestedStatus) ? c.suggestedStatus : 'wishlist',
      matchesId: ids.has(c.matchesId) ? c.matchesId : null,
    };
  }).filter((c) => c.name);

  const moves = (Array.isArray(json.moves) ? json.moves : [])
    .filter((m) => ids.has(m.id) && ['owned', 'ordered', 'wishlist'].includes(m.to));

  return {
    intent: json.intent || 'question', reply, candidates, moves, sources,
    searchHtml: gm.searchEntryPoint?.renderedContent || '', queries: gm.webSearchQueries || [],
    grounded: sources.length > 0,
  };
}

export async function listModels(key = settings.geminiKey) {
  const res = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || res.statusText);
  return (j.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(m.name))
    .map((m) => m.name.replace(/^models\//, ''));
}
