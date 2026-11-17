# Eevee Tracker

A personal Eevee collectibles tracker (owned, incoming, wishlist). It installs as an app on desktop and iPhone, keeps working offline, and includes a free AI assistant that **checks with Google Search that a brand or figure really exists** before anything is added.

- **Hosting:** GitHub Pages (free). No server, no build step.
- **Data:** `data/collection.json` and `data/notes.json` in this repo. Every change is a commit, so git history works as an undo log.
- **Photos:** stored in this repo (`data/photos/`, `data/note-photos/`). They're resized to about 800 px JPEG (~100–150 KB) before upload.
- **AI:** Google Gemini (free API key) with Google Search grounding.
- **Notes:** a quick-capture inbox for when the AI is out of quota. You can process notes with AI later, or convert them by hand.

## One-time setup

1. **Create the repo.** On github.com, click New repository, name it `eevee-tracker`, and make it **Public** (free Pages needs a public repo). Then push this folder:
   ```sh
   git remote add origin https://github.com/<you>/eevee-tracker.git
   git push -u origin main
   ```
2. **Turn on Pages.** In the repo, go to Settings → Pages → Build and deployment → *Deploy from a branch*, then pick `main` / `(root)`. The site will be at `https://<you>.github.io/eevee-tracker/`.
3. **Create a GitHub token.** Go to Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate:
   - Repository access: **Only select repositories → eevee-tracker**
   - Permissions → Repository → **Contents: Read and write**
   - Pick an expiry you're happy with. When it expires, the app shows "token rejected"; make a new one and paste it in.
4. **Get a Gemini key.** At <https://aistudio.google.com/apikey>, click Create API key (free, no card).
5. **Enter the keys.** Open the site → ⚙ Settings → paste the token and the Gemini key → **Test GitHub** → Save.

### Installing the app
- **Desktop (Chrome/Edge):** use the install icon in the address bar, or Settings → *Install app*.
- **iPhone:** open the site in **Safari** → Share → **Add to Home Screen**.
  - The home-screen app has **its own storage, separate from Safari**, so enter the keys inside the installed app.
  - Shortcut: on a device that's already set up, go to Settings → *Copy setup code*. Then paste the code into the iPhone app's Settings → *Paste setup code*. The code contains your keys, so keep it to your own devices.

## Using it
- **Add / Note / Ask AI** sit in the bottom dock.
- On a card: **Arrived** (Incoming → Owned), **Ordered** (Wishlist → Incoming), 🛡 check with AI, ✎ edit, 🗑 delete (with undo).
- **Assistant examples:**
  - `check for Funism` lists the Eevee products found for that brand, each marked tracked or not.
  - `found this, add it` plus a photo or listing screenshot identifies the item, verifies it, checks for duplicates, then lets you add it.
  - `is LDCX Blowing Light a real series?`
  - `MonColle Box Vol. 7 arrived` is matched locally with no AI call, and you confirm the move.
- **Verdicts:** ✓ Confirmed (a real shop or official page names it), ≈ Likely, ✕ Not found.
  - Sources come from Google's search results, never from links the AI wrote itself.
  - Nothing is added until you tap a button.
- **Out of quota?** The error offers *Save as note*. You can also tap **Note** at any time. Later, the Notes tab has **Process with AI** (one or all), **Convert** (manual add form, pre-filled), or a one-tap "Mark X Owned" when it recognises the item.
- **Offline:** the last synced list still loads. Notes, photos and edits wait in an on-device outbox and sync when you're back online. The pill at the top right shows the sync state.
- **Export:** Settings → Export Markdown (same layout as the original list) or JSON.

## Free limits (checked Nov 2026)
- Gemini free tier: Google Search grounding is free on `gemini-2.5-flash-lite` / `gemini-2.5-flash`, up to **500 grounded requests a day** (shared). The app defaults to `gemini-2.5-flash-lite`. Use Settings → *Load models* to see what your key can use. Limits change, so see <https://aistudio.google.com/rate-limit>.
- GitHub: keep the repo under ~1 GB, which is about 5,000+ photos at this size.

## Development
- Serve the folder over http, e.g. XAMPP at `http://localhost/eevee-tracker/` or `npx serve`. Service workers need http(s), so opening the file directly won't work.
- `node scripts/import-md.mjs <list.md>` re-imports a Markdown list. It **overwrites** `data/collection.json`.
- `node scripts/make-icons.mjs` regenerates the icons.
- The service worker loads app files network-first, so a push shows up on the next open (the cached copy is only used offline). Bump `VERSION` in `sw.js` when you add or rename app files.
