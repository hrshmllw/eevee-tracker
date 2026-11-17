// Minimal GitHub Contents API client (read/write files with SHA handling).
import { settings } from './settings.js';
import { b64ToUtf8 } from './util.js';

export class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const api = (path) => `https://api.github.com/repos/${settings.owner}/${settings.repo}${path}`;

export const gh = {
  get canRead() { return Boolean(settings.owner && settings.repo && settings.ghToken); },
  get canWrite() { return this.canRead; },

  async req(path, opts = {}) {
    const res = await fetch(api(path), {
      cache: 'no-store',
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${settings.ghToken}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
      throw new GitHubError(res.status, msg);
    }
    return res.status === 204 ? null : res.json();
  },

  /** @returns {Promise<{text:string, sha:string}|null>} */
  async getFile(path) {
    try {
      const j = await this.req(`/contents/${encodeURI(path)}?ref=${encodeURIComponent(settings.branch)}`);
      let b64 = j.content;
      if (!b64 && j.size > 0) b64 = (await this.req(`/git/blobs/${j.sha}`)).content; // files over 1 MB
      return { text: b64ToUtf8(b64 || ''), sha: j.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },

  async putFile(path, base64, sha, message) {
    const body = { message, content: base64, branch: settings.branch };
    if (sha) body.sha = sha;
    const j = await this.req(`/contents/${encodeURI(path)}`, { method: 'PUT', body: JSON.stringify(body) });
    return j.content.sha;
  },

  async checkAccess() {
    const r = await this.req('');
    return { name: r.full_name, push: Boolean(r.permissions?.push), private: r.private };
  },
};

export function rawUrl(path) {
  return `https://raw.githubusercontent.com/${settings.owner}/${settings.repo}/${settings.branch}/${path}`;
}
