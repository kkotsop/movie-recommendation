# SwipeFlick 🔥🍿

**Tinder for your Netflix queue.** A local app that reads your Netflix viewing history, looks at what's on Netflix in your country along with IMDb ratings, and deals you one title at a time. **Swipe right** and you'll see more like it. **Swipe left** and it never comes back.

Everything runs on your computer (`http://localhost:4173`). No account, no cloud, no tracking.

<p align="center"><img src="docs/swipe.png" width="260" alt="Swiping right on a card"> <img src="docs/lucky.png" width="260" alt="I'm feeling lucky result"> <img src="docs/settings.png" width="260" alt="Discovery settings"></p>

| Swipe | Button | Key | What it does |
|---|---|---|---|
| → right | 💚 heart | `→` | **Like**: more titles like this one |
| ← left | ❌ | `←` | **Nope**: never shown again, and similar titles show up less |
| ↑ up | ⭐ star | `Enter` | **Must watch**: a strong like, saved to *Likes → Must watch* |
| — | ↺ yellow | `Backspace` | **Rewind**: undo your last swipe |
| — | ✨ purple | `L` | **I'm feeling lucky**: one highly rated pick that fits your taste |
| tap left / right | — | `Space` | Flip between the poster, synopsis and "why it's here" pages |
| tap bottom / ⌃ | — | `↑` / `↓` | Open / close full details |

Other controls:
- **Reset**: the ↺ icon in the top bar (or *Discovery settings → Reset swipes*). *Profile → Reset everything* also clears your history and logs the app out of Netflix.
- **Include movies & series I've already watched**: a switch in Discovery settings (the sliders icon). When it's on, rewatches come back about **3× less often** than new titles and carry a "↻ Rewatch" chip.
- **Show me**: Movies / Series / Both, a minimum IMDb rating, and your Netflix country.

## Quick start

```bash
git clone https://github.com/kkotsop/movie-recommendation.git
cd movie-recommendation
npm install          # installs Playwright, used only for "Log in with Netflix"
npm start            # → http://localhost:4173
```

Requires Node 20+. "Log in with Netflix" uses your installed **Chrome or Edge**. If you have neither, run `npx playwright install chromium` once.

It works straight away with a built-in catalog of 100 Netflix originals that have real IMDb ratings. To swipe through **everything on Netflix in your country, with real posters**, add a free TMDB key:

1. Create an account at <https://www.themoviedb.org/> → *Settings → API* → copy the **API Key** (or the API Read Access Token).
2. In SwipeFlick go to **Profile → Catalog**, paste the key and tap **Save key**. The first build takes about a minute. It is cached for a week.

You can also set it before starting: `TMDB_API_KEY=xxxx npm start`.

## Hosting it online (Cloudflare)

`npm run build:static` builds `dist/`: the same UI plus the recommender running **inside the visitor's browser**. It needs no server, so it hosts as a plain static site on Cloudflare (Workers static assets, see `wrangler.jsonc`).

```bash
npm run deploy      # builds, then runs `wrangler deploy` (first time: it opens a browser to log in to Cloudflare)
```

The hosted version differs from the local app in three ways, all because it has no server:
- no **Log in with Netflix** window. Use the bookmark or upload the CSV instead; either way the data goes into your browser's storage only and is never uploaded anywhere.
- it swipes through the built-in catalog of 100 Netflix originals, without the TMDB key or country picker.
- swipes and history are saved in the visitor's own browser (`localStorage`), so everyone gets their own private profile. "Reset everything" deletes it.

## Getting your Netflix history in

Netflix has no public API or "sign in with Netflix" for third-party apps, so there are three ways:

1. **Sync Netflix bookmark (works with the hosted site too, nothing to install).** In the app, tap **Connect Netflix** and drag the **⚡ Sync Netflix** button onto your bookmarks bar, once. Then open netflix.com/viewingactivity (logged in as the profile you want) and click the bookmark. It reads the list on the page you're looking at (a minute for long histories) and opens SwipeFlick with your history loaded. The bookmark is generated for the address you opened the app from, so there's nothing to paste. Needs a desktop browser and pop-ups allowed.
2. **Log in with Netflix (local app only).** SwipeFlick opens its own Chrome/Edge window on netflix.com. **You** log in and pick a profile there; the app never sees your password.
3. **Upload the CSV, or paste the page text (the way on a phone).** On netflix.com: *Account → Profiles → your profile → Viewing activity → Download all*, then upload `NetflixViewingHistory.csv`. On a **phone** (where bookmarks can't be dragged), open that page in your phone's browser, tap *Download all*, then choose the file in SwipeFlick. If you can't get the file, tap *Show more* until the list is loaded, select all the text on the page, copy it and paste it into the box under *Connect Netflix → Paste instead*.

> The bookmark and option 2 read the Viewing activity page's HTML, so a Netflix redesign can break them. The CSV upload keeps working. Netflix's terms don't allow automated access to their site, so use these at your own discretion; everything stays on your computer.

The parser handles US and European date formats and groups episodes into shows ("Dark: Season 2: …" becomes *Dark*). It recognises season markers in English, Greek, German, French, Spanish, Italian and other languages.

> Netflix can change its Viewing activity page at any time. If the automatic sync stops working, the CSV upload still works. Netflix's terms don't allow automated access, and the sync drives a browser that is logged in to your account (you log in yourself). If that worries you, use the CSV upload.

## How Tinder works, and how SwipeFlick copies it

I took Tinder apart from its public behaviour: the app and web UI, its keyboard shortcuts, and what Tinder has said publicly about its matching. This app has no Tinder code or assets.

### The UX

| Tinder | SwipeFlick |
|---|---|
| A stack of full-bleed photo cards. The next card waits behind at ~95% scale and grows as you drag the top one | Same. The poster is the "photo" and the next card scales from 0.95 to 1 as you drag |
| The card follows your finger and rotates around the grab point (it tilts the opposite way if you grab the bottom half) | Same rotation rule (±22°, flipped for bottom-half grabs) |
| Green **LIKE** stamp top-left, red **NOPE** top-right, blue **SUPER LIKE** for an upward swipe. Their opacity tracks how far you've dragged | **LIKE / NOPE / MUST WATCH** stamps that work the same way |
| A swipe commits past a distance threshold **or** on a fast flick. Otherwise the card springs back | Commits past 35% of the card width or a flick faster than 0.6 px/ms. Otherwise an overshooting spring brings it back |
| The matching action button lights up while you drag | Same |
| 5-button bar: Rewind (yellow) · Nope (red) · Super Like (blue) · Like (green) · Boost (purple) | Rewind · Nope · Must watch · Like · **I'm feeling lucky** (in Boost's spot) |
| Tap the right/left of a photo to page through photos. Progress bars on top. A small bounce at the last photo | Three pages per card: poster → synopsis → "why it's here" |
| Name + **age** in big type, a green "Recently active" dot, then chips | Title + **year**, a green "Because you watched *Dark*" dot, then genre chips |
| Tap the bottom or ⌃ to open the full profile, with a ⌄ button to close it | Full details sheet with cast, director, keywords, IMDb link and a *Watch on Netflix* button |
| **"It's a Match!"** in script lettering over a blurred overlay | **"It's a Pick!"**, shown when *I'm feeling lucky* finds a title |
| Pulsing radar around your photo while it looks for people / when nobody is left | Same radar while the catalog builds or when you run out of titles |
| Discovery settings: distance slider, age range, "Show me" | Show me (Movies / Series / Both), minimum IMDb rating, Netflix country, the rewatch switch |
| Bottom tabs, a Likes grid with a badge, a profile with a completion ring | Discover · Likes (with a *Must watch* filter) · Profile with a "taste strength" ring and your top genres |
| Web shortcuts: ← → ↑ ↓ Enter Space | The same, plus `Backspace` = rewind and `L` = lucky |
| Pink → orange gradient | **Teal → indigo** gradient, as requested |

### The algorithm

Tinder used to rank people with an **Elo-style "desirability" score**. It now says it relies mostly on **your own activity**: what you swipe on, recency, and your preferences, plus some **exploration** so the stack doesn't get stale. Cards come in **small batches**, ranked with some randomness, and anything you've swiped is never shown again.

SwipeFlick does the same, but for titles, in `src/recommender.js`:

1. **Every title is a feature vector**: genres, keywords, director/creator, top cast, original language, decade, movie/series.
2. **Your taste is one vector too.** It starts from your Netflix history, where each show is weighted by **recency** (one-year half-life) × **engagement** (1 + log₂ of episodes watched). Then every swipe updates it: Like adds the title's features, Must watch adds them twice, Nope subtracts 0.7× and hides that title forever. The whole history counts about as much as 4 likes, so a few swipes quickly steer the deck.
3. **Score = cosine similarity to your taste + IMDb quality** (rating scaled around 6.5 and weighted by vote count).
4. **The deck is sampled** from the top 60 with a softmax over scores, not a fixed top 10, so it feels fresh. About 12% of cards are **exploration** picks (rated 7+ but outside your usual taste), labelled "Something different for you". Rewatches get their sampling weight × 0.3.
5. **I'm feeling lucky** looks only at unseen titles rated **7.5+ on IMDb** (dropping to 7.0, then to anything, if none are left), ranks them by fit + quality, and picks one of the top 3, so pressing it again can give a new answer.
6. **Rewind** pops the last swipe. Because the profile is rebuilt from history + swipes on every request, undo is exact.

## Data sources

- **IMDb ratings**: IMDb's official [non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/) (`title.ratings.tsv.gz`, downloaded and refreshed weekly). For personal, non-commercial use only.
- **What's on Netflix in your country, posters, cast, keywords**: [TMDB](https://www.themoviedb.org/), watch provider 8 (Netflix), via JustWatch data. *This product uses the TMDB API but is not endorsed or certified by TMDB.*
- **Built-in catalog**: `data/demo-catalog.json`, with 100 Netflix originals. IDs, genres, runtimes and ratings come from the IMDb datasets. The synopses and tags were written for this app.

"Watch on Netflix" opens a Netflix search for the title, because TMDB doesn't provide Netflix's own title IDs.

## Project layout

```
server.js              local HTTP server + JSON API (binds to 127.0.0.1 only)
src/history.js         Netflix CSV parsing, date-format detection, episode → show grouping
src/recommender.js     taste vectors, scoring, deck sampling, feeling lucky
src/catalog.js         TMDB catalog build + history matching, demo catalog
src/tmdb.js            TMDB client (v3 key or v4 token), detail mapping
src/engine.js          the API as pure functions, shared by the server and the browser build
src/imdb.js            IMDb ratings dataset download + lookup
src/netflix.js         "Log in with Netflix" browser flow (Playwright)
public/bookmarklet.js  the "Sync Netflix" bookmark (runs on netflix.com, posts the history to the app tab)
src/store.js           JSON state in ./data (swipes, settings, imported history)
public/                the Tinder-style UI (vanilla HTML/CSS/JS); local-api.js is the in-browser backend
scripts/build-static.mjs  builds dist/ for static hosting; wrangler.jsonc = Cloudflare config
test/                  node --test unit tests
```

Your data lives in `./data/` (git-ignored): `state.json`, caches, and the Netflix browser profile.

```bash
npm test
```

Not affiliated with Netflix, IMDb, TMDB or Tinder.
