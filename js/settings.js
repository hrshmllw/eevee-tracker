// Per-device settings cache in localStorage. The Gemini key and model are also saved to your
// account in Firestore (users/{uid}/meta/settings), so every signed-in device picks them up.
const KEY = 'eevee-tracker:settings';
export const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

function read() {
  try {
    const { geminiKey = '', model = DEFAULT_MODEL, iosTipSeen = false } = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { geminiKey, model, iosTipSeen };
  } catch { return {}; }
}

export const settings = { geminiKey: '', model: DEFAULT_MODEL, iosTipSeen: false, ...read() };

export function saveSettings(patch) {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage blocked: keep in memory */ }
}
