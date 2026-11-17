# Eevee Tracker

A personal Eevee collectibles tracker (owned, incoming, wishlist). It installs as an app on desktop and iPhone, keeps working offline, and includes a free AI assistant that **checks with Google Search that a brand or figure really exists** before anything is added.

- **Hosting:** GitHub Pages (free). No server, no build step. The repo holds only the app code.
- **Data:** Google Firestore on the free Spark plan (no card). It's private to your Google account. Items, notes, photos and your Gemini key live under `users/{your uid}/` and sync across your devices.
- **Sign-in:** Google. An optional email and password gets you into the same account where Google sign-in won't open.
- **Photos:** resized in the browser to about 800 px JPEG (~100–150 KB) and stored in Firestore. 1 GB of free space is roughly 7,000 photos.
- **AI:** Google Gemini (free key, `gemini-3.5-flash`) plans the searches and judges the results; **Tavily** (free key, 1,000 searches a month, no card) runs the web searches and reads links you paste.
- **Notes:** a quick-capture inbox for when the AI is out of quota. You can process notes with AI later, or convert them by hand.

## One-time Firebase setup (about 5 minutes)
Do this signed in to your **personal** Google account at <https://console.firebase.google.com>.

1. **Create a project.** Click *Create a project*, name it `eevee-tracker`, and turn Google Analytics off. It stays on the free Spark plan; no card needed.
2. **Turn on sign-in.** Go to Build → **Authentication** → Get started → *Sign-in method*:
   - Enable **Google**, and pick your email as the support email.
   - Enable **Email/Password**. Only the first switch is needed; leave "Email link" off.
3. **Allow the site.** Go to Authentication → *Settings* → **Authorized domains** → Add domain → `hrshmllw.github.io`. (`localhost` is already allowed.)
4. **Create the database.** Go to Build → **Firestore Database** → Create database:
   - Pick a location near you (e.g. `asia-southeast1`, Singapore). You can't change it later.
   - Choose **production mode**.
   - Open the **Rules** tab, replace its contents with this repo's [`firestore.rules`](firestore.rules), and click **Publish**.
5. **Register the web app.** Go to Project settings (⚙) → *Your apps* → **Web** (`</>`). Register it as "Eevee Tracker" with Hosting off, then copy the `firebaseConfig` values into [`js/firebase-config.js`](js/firebase-config.js) and push.
   - These values are meant to be public. What protects your data is sign-in plus the rules.
6. **First sign-in.**
   - Open <https://hrshmllw.github.io/eevee-tracker/> → *Sign in with Google*. The empty account offers **Import**; pick `data/collection.json` (kept locally, not in the repo).
   - Then go to ⚙ Settings and paste your Gemini key (<https://aistudio.google.com/apikey>) and Tavily key (<https://app.tavily.com>). Tap **Load models** and **Test search** to check them, then Save. The keys are saved to your account, so other devices pick them up.

### Installing the app
- **Desktop (Chrome/Edge):** use the install icon in the address bar, or Settings → *Install app*.
- **iPhone:** open the site in **Safari** → Share → **Add to Home Screen**, open the app, then sign in.
  - The home-screen app has its own storage, separate from Safari, so you sign in once inside it.
  - If *Sign in with Google* doesn't come back to the app, go to Settings → *Set an app password* on a device where you're signed in with Google. Then, in the iPhone app, use *Use email & password instead*. It's the same account and the same list.

## Using it
- **Add / Note / Ask AI** sit in the bottom dock.
- On a card: **Arrived** (Incoming → Owned), **Ordered** (Wishlist → Incoming), 🛡 check with AI, ✎ edit, 🗑 delete (with undo).
- **Assistant examples:**
  - `check for Funism` lists the Eevee products found for that brand, each marked tracked or not.
  - `found this, add it` plus a photo or listing screenshot identifies the item, verifies it, checks for duplicates, then lets you add it.
  - `is LDCX Blowing Light a real series?`
  - `MonColle Box Vol. 7 arrived` is matched locally with no AI call, and you confirm the move.
- **Verdicts:** ✓ Confirmed (a real shop or official page names it), ≈ Likely, ✕ Not found.
  - Sources are the Tavily search results the answer cites, never links the AI wrote itself. "Confirmed" requires at least one cited result.
  - Paste a shop or official link with your message and it reads that page too.
  - Nothing is added until you tap a button.
- **Out of quota?** The error offers *Save as note*. You can also tap **Note** at any time. Later, the Notes tab has **Process with AI** (one or all), **Convert** (manual add form, pre-filled), or a one-tap "Mark X Owned" when it recognises the item.
- **Offline:** your list and photos you've already viewed still load. Changes and notes are saved on the device and sync when you're back online. The pill at the top right shows the sync state.
- **Export / import:** Settings → Export Markdown (same layout as the original list), Export JSON, or Import JSON.

## Free limits (checked Nov 2026)
- **Firestore (Spark):** 1 GiB stored, 50k reads/day, 20k writes/day. That's far more than one collection needs.
  - Any Google account can sign in, but the rules only let it see its own empty space. To lock the database to just you, change the rule to `request.auth.uid == '<your uid>'`.
- **Gemini free tier:** plain requests are free; each question uses 2 (plan + judge). Google's own Search grounding is *not* free on current models, which is why search goes through Tavily. Older models (`gemini-2.5-*`) aren't offered to new keys. Limits: <https://aistudio.google.com/rate-limit>.
- **Tavily free plan:** 1,000 searches a month, no card. A question uses 1–3; pasted links use one extract. When it runs out, searches stop until the 1st (no charges).

## Development
- Serve the folder over http, e.g. `npx serve` and open `http://localhost:3000/`. Service workers and sign-in need http(s), so opening the file directly won't work.
- `node scripts/import-md.mjs <list.md>` turns a Markdown list into `data/collection.json`, which you then import in the app. `data/` is git-ignored.
- Icons in `icons/` (plus `favicon.ico`) are made from one square PNG: `logo.png`, `favicon-32.png`, `icon-192/512.png` (transparent circle), and `icon-maskable-512.png` / `apple-touch-icon.png` (on a solid square, no transparency, so iOS and Android crops look right).
- The Firebase SDK is loaded from gstatic, pinned to 11.10.0 in `js/store.js` and `sw.js`. Keep both in sync.
- The service worker loads app files network-first, so a push shows up on the next open (the cached copy is only used offline). Bump `VERSION` in `sw.js` when you add or rename app files.
