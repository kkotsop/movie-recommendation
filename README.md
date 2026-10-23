# SwipeFlick 🔥🍿

**Tinder for your Netflix queue.** A local app that reads your Netflix viewing history, looks at what's on Netflix in your country along with IMDb ratings, and deals you one title at a time. **Swipe right** and you'll see more like it. **Swipe left** and it never comes back.

**Your history and swipes stay on your own device.** The server only holds the shared Netflix catalog; it never stores anyone's viewing history, and SwipeFlick never asks for, sees or stores a Netflix password. No account to make, no tracking.

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
- **Reset**: *Discovery settings → Reset swipes* clears your swipes. *Profile → Reset everything* also clears your imported history from this device.
- **Include movies & series I've already watched**: a switch in Discovery settings (the sliders icon). When it's on, rewatches come back about **3× less often** than new titles and carry a "↻ Rewatch" chip.
- **Show me**: Movies / Series / Both, a minimum IMDb rating, and your Netflix country.

## Run it on your computer

```bash
git clone https://github.com/kkotsop/movie-recommendation.git
cd movie-recommendation
npm install
npm start            # → http://localhost:8787  (the real Cloudflare Worker runtime, running locally)
```

Requires Node 20+. It works straight away with a built-in sample of 100 Netflix originals that have real IMDb ratings. For **everything on Netflix in your country, with real posters and what's trending**, the owner (you, once) adds a free TMDB key. Put it in a file called `.dev.vars` (git-ignored) next to `wrangler.jsonc`:

```
TMDB_API_KEY=your-key
```

Get the key at <https://www.themoviedb.org/settings/api>. **Players never need a TMDB account or key**: only the person who deploys it sets one, and the app has no field for it. The first build of a country's catalog takes a minute or two and runs in the background; until it's ready everyone swipes the sample.

## Deploy it on Cloudflare

SwipeFlick is a PWA: open it in a phone browser and **Add to Home Screen** for a full-screen app with its own icon. Phones only install PWAs over **HTTPS**, which Cloudflare gives you for free.

**You need the Workers Paid plan ($5/month).** The free plan allows only 10 ms of CPU per request and 50 outbound requests, which is too little for scoring a catalog or building one.

```bash
npx wrangler login
npx wrangler r2 bucket create swipeflick-cache     # shared Netflix catalog, one file per country
npx wrangler secret put TMDB_API_KEY               # paste the owner's key; it is never sent to browsers
npm run deploy
```

Wrangler prints your URL (`https://swipeflick.<your-subdomain>.workers.dev`). Open it on your phone and add it to the home screen. For your own domain, add a custom domain to the Worker in the Cloudflare dashboard (*Workers & Pages → swipeflick → Settings → Domains & Routes*).

What gets created and what each piece does (all declared in `wrangler.jsonc`):

| Piece | What it's for |
|---|---|
| Static assets (`public/`) | The app itself. Free and unlimited; only `/api/*` runs code. |
| R2 bucket `swipeflick-cache` | The Netflix catalog and trending list for each country. |
| Durable Object `Shared` | Shared TMDB lookups, build status, rate limits and transfer codes. **Never anyone's history or swipes.** |
| Workflow `BuildCatalog` | Builds a country's catalog in the background (~1,000 TMDB lookups) the first time someone picks that country. |
| Cron (every 6 h) | Refreshes trending daily and rebuilds any catalog older than a week. |

Settings: `DEFAULT_REGION` in `wrangler.jsonc` is the Netflix country used until someone picks theirs (default `US`).

**Protect your TMDB quota.** Anyone with the link can use the app, and the first visitor in a new country triggers a catalog build. The expensive endpoints are rate limited per client, but add a Cloudflare rate-limiting rule on `/api/*` as well (*Security → WAF → Rate limiting rules*; roughly 100 requests per minute per IP is plenty for real use).

### Where each person's data lives

Each installed app keeps **its own** Netflix history, swipes and settings in the phone's browser storage. Every request sends what the server needs to work out recommendations, and the server forgets it as soon as it answers (the tests check that nothing personal reaches the Worker's storage). Consequences worth knowing:

- Clearing site data or switching phones loses it. Use **Profile → Move your data** to get a one-time code (valid once, for 10 minutes) and enter it on the other device.
- **iPhone keeps the home-screen app and Safari separate.** The Netflix bookmark runs in Safari, so after syncing, use *Move your data* to carry the history into the home-screen app.
- Titles someone watched are looked up on TMDB once and the answer is shared, so the first person pays for the lookup and everyone after gets it free. The shared table holds titles, not who watched them.

## Getting your Netflix history in

Netflix has no public API and SwipeFlick never asks for your password, so history comes in through **your own signed-in browser**:

1. **Sync from Netflix (bookmark).** *Sync from Netflix* shows a one-time bookmark to save (iPhone: do it in **Safari**; Android: Chrome). Open *netflix.com/viewingactivity*, sign in, pick your profile, and tap the bookmark. It reads the same list "Download all" gives you, inside your browser, and brings it back to SwipeFlick. Netflix's password and session never leave netflix.com.
2. **Upload the CSV** (*Profile → Upload CSV*): on netflix.com go to *Account → Profiles → your profile → Viewing activity → Download all*.

The parser handles US and European date formats and groups episodes into shows ("Dark: Season 2: …" becomes *Dark*). It recognises season markers in English, Greek, German, French, Spanish, Italian and other languages.

> Netflix can change its Viewing activity page at any time, which would break the bookmark's page-reading fallback (the CSV upload keeps working). The bookmark has only been tested against a stand-in page, not netflix.com itself. Netflix's terms don't allow automated access, so use the sync at your own discretion.

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
5. **What's trending now counts a little.** Once a day the app fetches TMDB's trending list and Netflix's most popular titles in your country and adds a small bonus (up to 0.15 of the score) to titles that are hot right now. Taste still wins: a trending title that doesn't fit you won't beat one that does. Cards show "Trending on Netflix now" when that's the best reason.
6. **Today's picks** (the sun tab) is five highly rated titles (7+) from your best matches, chosen with a date-seeded draw, so the list is the same all day and different tomorrow.
7. **I'm feeling lucky** looks only at unseen titles rated **7.5+ on IMDb** (dropping to 7.0, then to anything, if none are left), ranks them by fit + quality, and picks one of the top 3, so pressing it again can give a new answer.
8. **Rewind** pops the last swipe. Because the profile is rebuilt from history + swipes on every request, undo is exact.

## Data sources

- **IMDb ratings**: IMDb's official [non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/) (`title.ratings.tsv.gz`, downloaded and refreshed weekly). For personal, non-commercial use only.
- **What's on Netflix in your country, posters, cast, keywords**: [TMDB](https://www.themoviedb.org/), watch provider 8 (Netflix), via JustWatch data. *This product uses the TMDB API but is not endorsed or certified by TMDB.*
- **Built-in catalog**: `data/demo-catalog.json`, with 100 Netflix originals. IDs, genres, runtimes and ratings come from the IMDb datasets. The synopses and tags were written for this app.

"Watch on Netflix" opens a Netflix search for the title, because TMDB doesn't provide Netflix's own title IDs.

## Project layout

```
worker/index.js        the API (a Cloudflare Worker) and scheduled job
worker/shared.js       Durable Object: shared lookups, build status, rate limits, transfer codes
worker/build.js        Workflow that builds one country's catalog in the background
src/history.js         Netflix CSV parsing, date-format detection, episode → show grouping
src/recommender.js     taste vectors, scoring, deck sampling, daily picks, feeling lucky
src/catalog.js         TMDB catalog + history matching, trending (storage-free, runs anywhere)
src/tmdb.js            TMDB client (v3 key or v4 token), detail mapping
src/imdb.js            IMDb ratings dataset, streamed and filtered
src/demo.js            the built-in 100-title sample
public/                the Tinder-style UI (vanilla HTML/CSS/JS, no build step)
public/device-store.js    your history, swipes and settings, kept on the device
public/netflix-export.js  the "Sync from Netflix" bookmark
public/sw.js           service worker (offline shell, cached posters)
scripts/make-icons.js  renders the PNG app icons from public/icon.svg
wrangler.jsonc         Cloudflare configuration
test/                  unit, API, TMDB-flow and browser end-to-end tests
```

```bash
npm test      # runs the real Worker locally; no Cloudflare account or TMDB key needed
```

The tests start the actual Worker in Wrangler's local runtime (with its own R2 and Durable Object storage) and a fake TMDB/IMDb server, so they cover the background catalog build, shared lookups, ratings, trending and the privacy guarantees. The browser tests drive Chrome, Edge or Playwright's Chromium and skip themselves if none is installed. CI (`.github/workflows/test.yml`) runs everything on Node 20 and 24.

Not affiliated with Netflix, IMDb, TMDB or Tinder.
