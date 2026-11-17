// Per-device settings in localStorage (never committed to the repo).
const KEY = 'eevee-tracker:settings';
export const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

function guessRepo() {
  const { hostname, pathname } = location;
  if (hostname.endsWith('.github.io')) {
    const owner = hostname.split('.')[0];
    const first = pathname.split('/').filter(Boolean)[0];
    return { owner, repo: first || hostname };
  }
  return { owner: '', repo: 'eevee-tracker' };
}

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

export const settings = {
  branch: 'main', ghToken: '', geminiKey: '', model: DEFAULT_MODEL, iosTipSeen: false,
  ...guessRepo(),
  ...read(),
};

export function saveSettings(patch) {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage blocked: keep in memory */ }
}

// Setup code: lets you move keys to another device (e.g. the iPhone home-screen app) by pasting one string.
export function makeSetupCode() {
  const { owner, repo, branch, ghToken, geminiKey, model } = settings;
  return 'EEVEE1.' + btoa(unescape(encodeURIComponent(JSON.stringify({ owner, repo, branch, ghToken, geminiKey, model }))));
}
export function applySetupCode(code) {
  const raw = String(code).trim().replace(/^EEVEE1\./, '');
  const data = JSON.parse(decodeURIComponent(escape(atob(raw))));
  const allowed = ['owner', 'repo', 'branch', 'ghToken', 'geminiKey', 'model'];
  const patch = Object.fromEntries(Object.entries(data).filter(([k, v]) => allowed.includes(k) && typeof v === 'string'));
  saveSettings(patch);
  return patch;
}
