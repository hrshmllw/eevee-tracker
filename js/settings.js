// Per-device settings cache in localStorage. The Gemini and Tavily keys and the model are also saved to your
// account in Firestore (users/{uid}/meta/settings), so every signed-in device picks them up.
const KEY = 'eevee-tracker:settings';
export const DEFAULT_MODEL = 'gemini-3.5-flash';
// Models Google no longer offers to new keys: fall back to the default.
export const RETIRED = /^gemini-(1\.|2\.0|2\.5-flash)/;
export const fixModel = (m) => (!m || RETIRED.test(m) ? DEFAULT_MODEL : m);

function read() {
  try {
    const { geminiKey = '', tavilyKey = '', model = DEFAULT_MODEL, iosTipSeen = false } = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { geminiKey, tavilyKey, model: fixModel(model), iosTipSeen };
  } catch { return {}; }
}

export const settings = { geminiKey: '', tavilyKey: '', model: DEFAULT_MODEL, iosTipSeen: false, ...read() };

export function saveSettings(patch) {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage blocked: keep in memory */ }
}
