# Swipeflix 🍿

**Tinder for your Netflix queue.** A local app that reads your Netflix viewing history, looks at what's on Netflix in your country along with IMDb ratings, and deals you one title at a time. **Swipe right** and you'll see more like it. **Swipe left** and it never comes back.

**Your history and swipes stay on your own phone.** Recommendations are worked out there, so your viewing history is never sent to a server, and Swipeflix never asks for, sees or stores a Netflix password. No account to make, no tracking. Free to run.

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

## How it works (and why it costs nothing)

- **Your phone does the recommending.** It downloads your country's Netflix catalog once (a few hundred KB, cached for offline use) and scores it against your history and swipes *on the phone*. Your history and swipes are never sent to a server.
- **A scheduled GitHub job builds the catalogs** (every day, free) from TMDB and IMDb's ratings and publishes them as static files.
- **A tiny Cloudflare Worker (free plan)** serves the app and those files, looks up the names of watched titles the catalog doesn't know, and holds one-time codes for moving data between devices.

No paid Cloudflare plan, no R2, no credit card: only a free Cloudflare account, a free GitHub account and a free TMDB key.

## Set it up (about 15 minutes, all free)

### 1. Get a TMDB key
Create a free account at <https://www.themoviedb.org/signup>, then request an API key at <https://www.themoviedb.org/settings/api> (choose *Developer*, personal use; for the application URL use your repo's address). Players never need a TMDB account: only you, the owner, use this key.

### 2. Build the catalogs on GitHub
1. In your repo: *Settings → Secrets and variables → Actions → New repository secret*. Name it `TMDB_API_KEY` and paste the key.
2. Add the workflow (see the note below), then open the *Actions* tab → **catalogs** → *Run workflow*. The first run takes 10 to 20 minutes. After that it runs every night and only fetches what's new.
3. It publishes the files to a branch called `data`. The repo must be public so the Worker can read them. (Prefer private? Run `TMDB_API_KEY=... npm run catalogs` yourself and host the `data-out/` folder anywhere, then change `CATALOG_BASE` in `wrangler.jsonc`.)

Which countries? All of those listed in `public/lib/regions.js`. A country with no catalog yet simply shows the built-in 100-title sample.

### 3. Deploy the app to Cloudflare
```bash
npm install
npx wrangler login          # opens your browser once
npm run deploy              # prints your URL: https://swipeflix.<you>.workers.dev
```
That's it for the app. Everything it uses (static files, one Durable Object) is on Cloudflare's free plan and needs no payment method.

### 4. (Optional) Recognise more of people's watched titles
Titles Netflix no longer has, or that are named in another language, aren't in the catalog. The Worker can look those up by name if you give it your TMDB key:

```bash
npx wrangler secret put TMDB_API_KEY
```
Without it everything still works; those titles just don't shape a person's taste profile. The key is never sent to browsers.

### 5. Install it on your phone
Open the URL on the phone, then **Add to Home Screen** (iPhone: Safari → Share). Phones only install web apps over HTTPS, which Cloudflare provides. For your own domain, add a custom domain to the Worker in the Cloudflare dashboard.

> **Adding the GitHub workflow:** GitHub only lets a token with the `workflow` permission push files under `.github/workflows/`, so the workflow lives at `scripts/catalogs.workflow.yml` for you to copy. On GitHub choose *Add file → Create new file*, name it `.github/workflows/catalogs.yml`, paste in that file's contents and commit.

### Free-plan limits worth knowing
- Workers Free allows 100,000 requests a day and only counts calls to `/api/*`; the app itself is served as free static files. Each person makes a handful of API calls a day (a catalog download at most weekly, a few lookups after an import), so this covers a very large number of people.
- Each Worker call has 10 ms of CPU. That's why the phone does the scoring and the catalogs are built on GitHub instead of in the Worker.
- Optional but wise: add a Cloudflare rate-limiting rule on `/api/*` (*Security → WAF → Rate limiting rules*, free tier includes one) so nobody can burn your daily quota.

## Run it on your computer

```bash
git clone https://github.com/kkotsop/movie-recommendation.git
cd movie-recommendation
npm install
npm start            # → http://localhost:8787  (the real Cloudflare Worker runtime, running locally)
```

Requires Node 22+ (Wrangler needs it). With no catalogs published it uses the built-in sample. To try a real catalog locally: `TMDB_API_KEY=your-key REGIONS=US npm run catalogs`, then serve `data-out/` with any static server and set `CATALOG_BASE` (in `wrangler.jsonc`, or `npx wrangler dev --var CATALOG_BASE:http://localhost:9000/catalog`).

### Where each person's data lives

Each installed app keeps **its own** Netflix history, swipes and settings in the phone's browser storage, and works everything out there. The only things that ever reach a server are the *names* of watched titles the phone couldn't recognise (to look them up on TMDB; no dates, no swipes, nothing that identifies anyone) and, if someone uses *Move your data*, the data they choose to move. The tests check this. Consequences worth knowing:

- Clearing site data or switching phones loses it. Use **Profile → Move your data** to get a one-time code (valid once, for 10 minutes) and enter it on the other device.
- **iPhone keeps the home-screen app and Safari separate.** The Netflix bookmark runs in Safari, so after syncing, use *Move your data* to carry the history into the home-screen app.
- Titles someone watched are looked up on TMDB once and the answer is shared, so the first person pays for the lookup and everyone after gets it free. The shared table holds titles, not who watched them.

## Getting your Netflix history in

Netflix has no public API and Swipeflix never asks for your password, so history comes in through **your own signed-in browser**:

1. **Sync from Netflix (bookmark).** *Sync from Netflix* shows a one-time bookmark to save (iPhone: do it in **Safari**; Android: Chrome). Open *netflix.com/viewingactivity*, sign in, pick your profile, and tap the bookmark. It reads the same list "Download all" gives you, inside your browser, and brings it back to Swipeflix. Netflix's password and session never leave netflix.com.
2. **Upload the CSV** (*Profile → Upload CSV*): on netflix.com go to *Account → Profiles → your profile → Viewing activity → Download all*.

The parser handles US and European date formats and groups episodes into shows ("Dark: Season 2: …" becomes *Dark*). It recognises season markers in English, Greek, German, French, Spanish, Italian and other languages.

> Netflix can change its Viewing activity page at any time, which would break the bookmark's page-reading fallback (the CSV upload keeps working). The bookmark has only been tested against a stand-in page, not netflix.com itself. Netflix's terms don't allow automated access, so use the sync at your own discretion.

## How Tinder works, and how Swipeflix copies it

I took Tinder apart from its public behaviour: the app and web UI, its keyboard shortcuts, and what Tinder has said publicly about its matching. This app has no Tinder code or assets.

### The UX

| Tinder | Swipeflix |
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

Swipeflix does the same, but for titles, in `src/recommender.js`:

1. **Every title is a feature vector**: genres, keywords, director/creator, top cast, original language, decade, movie/series.
2. **Your taste is one vector too.** It starts from your Netflix history, where each show is weighted by **recency** (one-year half-life) × **engagement** (1 + log₂ of episodes watched). Then every swipe updates it: Like adds the title's features, Must watch adds them twice, Nope subtracts 0.7× and hides that title forever. The whole history counts about as much as 4 likes, so a few swipes quickly steer the deck.
3. **Score = cosine similarity to your taste + IMDb quality** (rating scaled around 6.5 and weighted by vote count).
4. **The deck is sampled** from the top 60 with a softmax over scores, not a fixed top 10, so it feels fresh. About 12% of cards are **exploration** picks (rated 7+ but outside your usual taste), labelled "Something different for you". Rewatches get their sampling weight × 0.3.
5. **What's trending now counts a little.** Every day the catalog build fetches TMDB's trending list and Netflix's most popular titles in your country and adds a small bonus (up to 0.15 of the score) to titles that are hot right now. Taste still wins: a trending title that doesn't fit you won't beat one that does. Cards show "Trending on Netflix now" when that's the best reason.
6. **Today's picks** (the sun tab) is five highly rated titles (7+) from your best matches, chosen with a date-seeded draw, so the list is the same all day and different tomorrow.
7. **I'm feeling lucky** looks only at unseen titles rated **7.5+ on IMDb** (dropping to 7.0, then to anything, if none are left), ranks them by fit + quality, and picks one of the top 3, so pressing it again can give a new answer.
8. **Rewind** pops the last swipe. Because the profile is rebuilt from history + swipes on every request, undo is exact.

## Data sources

- **IMDb ratings**: IMDb's official [non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/) (`title.ratings.tsv.gz`, downloaded and refreshed weekly). For personal, non-commercial use only.
- **What's on Netflix in your country, posters, cast, keywords**: [TMDB](https://www.themoviedb.org/), watch provider 8 (Netflix), via JustWatch data. *This product uses the TMDB API but is not endorsed or certified by TMDB.*
- **Built-in catalog**: `public/demo-catalog.json`, with 100 Netflix originals. IDs, genres, runtimes and ratings come from the IMDb datasets. The synopses and tags were written for this app.

"Watch on Netflix" opens a Netflix search for the title, because TMDB doesn't provide Netflix's own title IDs.

## Project layout

```
public/                the app: Tinder-style UI in vanilla HTML/CSS/JS, no build step
public/lib/            recommender, history parsing, matching and the engine: they run on the phone and in the tests
public/device-store.js    your history, swipes and settings, kept on the device
public/netflix-export.js  the "Sync from Netflix" bookmark
public/sw.js           service worker (offline use, cached catalogs and posters)
public/demo-catalog.json  the built-in 100-title sample
worker/index.js        the small Cloudflare Worker: catalog files, title lookups, transfer codes
worker/shared.js       Durable Object: shared lookups, rate limits, transfer codes (never anyone's history)
scripts/build-catalogs.js  builds the per-country catalogs (run daily by GitHub)
src/                   TMDB and IMDb clients and catalog building (used by the builder and the Worker)
.github/workflows/test.yml  runs the tests
scripts/catalogs.workflow.yml  the daily catalog build (copy it to .github/workflows/)
wrangler.jsonc         Cloudflare configuration
test/                  unit, builder, Worker and browser end-to-end tests
```

```bash
npm test      # runs the real Worker locally; no Cloudflare account or TMDB key needed
```

The tests start the actual Worker in Wrangler's local runtime and a fake TMDB/IMDb server, so they cover the catalog build, the Worker, the engine, privacy guarantees and offline use. The browser tests drive Chrome, Edge or Playwright's Chromium and skip themselves if none is installed. CI (`.github/workflows/test.yml`) runs everything on Node 22 and 24.

Not affiliated with Netflix, IMDb, TMDB or Tinder.
