# Sprints

Each sprint is a thin, shippable vertical slice, built test-first. Terms follow `GLOSSARY.md`; the
architecture is in `docs/adr/0001-web-app-single-container.md`.

## Backlog

| # | Goal | Done when |
|---|---|---|
| 0 | Tooling and walking skeleton | `make test` green; `docker compose up` serves the UI shell and `/api/health` |
| 1 | Drop a board, run with defaults, see a report | Board upload persists to the volume and shows its age; Run returns a Report rendered as Best Slips / Top Legs / Unpriced; e2e smoke passes |
| 2 | Run settings | League chips, stake, Advanced panel (hours, devig, ref slip, top N, no-cache); type/size filters on the Report without re-running; settings remembered (promotions excluded); JSON download |
| 3 | Promotions | None / Bonus / Boost × control; feed promos toggle; promo-leg picker built from the board |
| 4 | Progress and polish | ~~Streamed run steps~~ (done in Sprint 3); motion and interaction pass (Emil Kowalski skills); taste-skill review; dark mode; mobile reflow; config override mount; README leads with the app |
| 6 | Faster fetching, same politeness | Runs time themselves per book; a run fetches only what the board can use; books fetch in parallel, each paced on its own; a recorded live run beats the 208 s baseline |
| 7 | Concurrent requests per book | Pacing per book in `books.json`; a rate-limited book backs off and says so; a full slate runs fresh in under 30 s |
| 8 | Board from the partner feed | Every run fetches the board itself; a manual run falls back to the saved board when the fetch fails; the CLI fetches by default; no stealth browser |
| 9 | Auto runs | Settings live on the server; auto runs on the quarter hour survive restarts; a failed board fetch switches them off; the page shows the latest run's report |
| 10 | ntfy alerts | Topic setup (own or random, check, test); medium and high alert tiers with adjustable edge and leg count; repeats drop to priority 1; a failed board fetch alerts at priority 4 |
| 11 | UX/UI pass | Review against the laws of UX with taste-skill and Emil Kowalski's skills, keeping achromatic-ledger; major changes signed off from before/after screenshots |

## Sprint 0: Tooling and walking skeleton

**Goal:** every later sprint can start with a failing test and end with a running container.

**Done criteria**
- [x] `ppopt.web` FastAPI app: `/api/health`, SPA fallback, unknown `/api/*` → 404 (pytest)
- [x] Dockerfile (node build stage → python slim runtime, no stealth browser), compose file with data volume and optional `config/` mount, Makefile
- [x] Node LTS installed (v26 "Lithium" via nvm; image builds on `node:26-alpine`)
- [x] Emil Kowalski's skills installed user-wide (`npx skills add emilkowalski/skills -g` → `~/.agents/skills`, symlinked into `~/.claude/skills`)
- [x] `web/` scaffold: React + TS + Vite, Vitest + Testing Library, Playwright; one failing-then-passing component test
- [x] `docker compose up` serves the shell; e2e smoke hits it

**Review:** done 2026-11-02. All criteria met; `make test` green (190 pytest + 3 Vitest), e2e smoke green against the container.

**Notes**
- The e2e smoke caught a real bug: `ppopt` is pip-installed in the image, so the `__file__`-relative
  `web/dist` path pointed into site-packages. The static dir now comes from `PPOPT_WEB_DIST` (set in the
  Dockerfile), falling back to the repo path for local runs.
- `make` is not installed in WSL (`sudo apt install make`); the targets were run by hand.

## Sprint 1: Drop a board, run with defaults, see a report

**Goal:** the app does the CLI's default job end to end in a browser.

**Done criteria**
- [x] `PUT /api/board` saves the upload to the data volume (rejects anything that isn't a projections feed); `GET /api/board` returns its age and line count
- [x] `POST /api/run` runs the engine with CLI defaults and returns the Report; engine errors come back as 422 with the message, a stale board (>30 min) adds a warning
- [x] UI: drop or choose a board, see "saved N min ago" with a stale flag, Run, see Best Slips / Top Legs / Unpriced and any warnings
- [x] "How to get a board" steps with links to app.prizepicks.com and the projections feed; open when there is no board or it is stale
- [x] e2e: upload a board, reload (persisted), run, read the report

**Notes**
- `cli.report_for` is now the shared engine entry point for the CLI and the web app; legs carry a `matchup` label.
- The CLI's config root had the same pip-install problem as the SPA path: it's now `PPOPT_ROOT` (set to `/app`
  in the image), and the odds cache lives in the data volume.
- `make e2e` runs a separate compose project on port 8001 with `PPOPT_ODDS_FILE` pointing at
  `tests/fixtures/markets.json`, so it's deterministic and doesn't need live books or a US connection. The spec
  shifts the fixture board's start times to two hours from now.
- A board with no games left in the window now fails fast with "save a fresh board" instead of fetching both books first.

**Review:** done 2026-11-02. Checked against live books with a fresh board; added in-page board instructions.

## Sprint 2: Run settings

**Goal:** everything the CLI can tune (apart from promotions) is a control on the page.

**Done criteria**
- [x] `GET /api/options` serves leagues, devig methods, reference slips and defaults from the engine and `payouts.json`
- [x] `POST /api/run` takes `{sports, stake, hours, devig, ref_slip, no_cache}`; every field optional, unknown fields and bad values are 422
- [x] League chips and stake on the page; Advanced panel with hours ahead, devig, edge reference slip, legs to show, fresh odds
- [x] Run is blocked with a reason when no league is picked or stake/hours aren't positive
- [x] Report filters by slip type and size, and legs to show, change the view without re-running
- [x] Settings and filters remembered in the browser (`localStorage`), validated against the engine's options on load; fresh odds is per-run and never remembered, and promotions won't be either
- [x] Download JSON saves the report as `ppopt-report-<local time>.json`
- [x] e2e: change leagues, stake and reference slip, run, filter, download, reload and see settings kept

**Review:** _pending_

## Sprint 3: Promotions

**Goal:** every CLI promotion is available on the page, with promo legs picked from the board instead of typed.

**Done criteria**
- [x] `POST /api/run` takes `bonus`, `boost` (> 1), `promo_legs` and `feed_promos`; more than one kind of promotion is a 422, as on the CLI
- [x] Promo legs arrive structured (`sport, matchup, player, stat_label, side, line`) and go through the CLI's own `--promoLeg` parsing, so an unpriceable leg is a 422 carrying the engine's message
- [x] `GET /api/board/lines?sports=&hours=` lists the board's priceable standard lines in the window (deduped, sorted); the parsed board is cached per upload
- [x] Promotion control: None / Bonus entry / Boost × / Promo legs; Run blocked with a reason for a boost ≤ 1 or Promo legs with none added
- [x] Feed promos toggle; disabled with a note under Bonus or Boost, where the engine ignores them
- [x] Promo-leg picker: search the board's lines, choose one, pick Over/Under and a half-point promo line, add; remove from the list
- [x] Promotions are never remembered
- [x] e2e: a promo leg picked from the board shows up priced (`manual`) in Top Legs; Bonus entry runs Power slips only
- [x] Run progress (pulled forward from Sprint 4 at review): a progress bar with a percentage and the current step

**Progress notes**
- Progress is counted in sportsbook requests, which is where a run spends its time (1–2 s polite delay each);
  pricing the board's lines afterwards is instant.
- The engine estimates each book's requests per league from the board and `books.json` before fetching; each
  book replaces its estimate with the exact count once it has read that league. Tests pin that a collector's plan
  equals the requests it makes. A failed book's unfetched requests are dropped from the total.
- `POST /api/run` streams NDJSON (progress events, then `report` or `error`) when asked with
  `Accept: application/x-ndjson`; otherwise it still returns plain JSON. The bar never moves backwards.
- Live check, 2026-11-02: first estimate 46, actual 41, 66 s with fresh odds.

**Review:** done 2026-11-02, with run progress added.

## Sprint 4: Progress and polish

**Goal:** the app looks and behaves like a finished tool, and the README leads with it.

**Done criteria**
- [x] Streamed run steps: done in Sprint 3 (progress bar with percentage)
- [x] No-props warning: a book with games in the window but no player props posted says so, instead of a league
      silently priced by one book
- [x] Config override mount: an edited `payouts.json`, `books.json`, `stats.json`, `teams.json` or `aliases.json`
      in `config/` replaces the built-in one, for the app (mounted read-only) and the CLI, from the next run
- [x] Motion and interaction pass (`emil-design-eng`): press feedback on every pressable (scale 0.97, 160ms, strong
      ease-out), hover gated to fine pointers, the disclosure chevron rotates, results arriving fade in once
      (180ms, opacity only). Filters, chips and typing don't animate. Reduced motion drops the movement.
- [x] taste-skill review (app-screen run): style **achromatic-ledger** (seed 931360211); face: blue-grey ledger ground
      under white cards, Geist (self-hosted), an ink slip mark. Before: 2 FAIL (indigo accent, text 15px from the edge),
      2 WARN, uppercase table headers and badge, 7 type sizes. After: 0 FAIL, 0 WARN on lint and the inspector at
      1440/768/390; the slip EV is now the screen's largest figure; settings are a card with labelled leagues; an
      honest "No report yet" state replaces the empty screen.
- [x] Dark mode: System / Light / Dark switch in the header, remembered, applied before first paint
- [x] Mobile reflow: below 40rem the Top Legs table becomes one card per leg and the unpriced list wraps; e2e checks
      nothing scrolls sideways at 375px
- [x] README leads with the app: quick start with Docker, using the app, then the CLI

**Notes**
- The app-screen rules say a working screen performs no entrances, so the motion pass's first draft (a staggered
  slide-in of report sections) was cut back to a single fade when a result arrives. The two skills agree on
  everything else.
- The taste inspector runs against Playwright's Chromium: `CHROME_PATH=~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`.
- Added at review: Best Slips legs never wrap mid-phrase. Desktop and tablet: one slip per row, each leg on one line in
  aligned columns (odds, sport, matchup, player, line). Phone: two lines per leg, the line beneath, nothing cut off.
  e2e checks all three widths.
- `CLAUDE.md` names the external skills and when to use each; the README's References section lists their repos and
  install steps.

**Review:** done 2026-11-02.

## Code review (web app changes since 9a16d2e)

Ten findings, all fixed test-first:
- A run going when the board was replaced could report the old board's results on the new one: the board is locked
  while a run is going.
- Promo legs outlived their league or board and failed the whole run: Run is blocked with a reason when a promo
  leg's league isn't selected, a new board clears promo legs, and engine messages say "promo leg", not `--promoLeg`.
- A run kept scraping after its browser went away: closing the stream cancels the run at its next request.
- Board upload blocked the event loop while parsing: it runs on a worker thread and primes the board cache.
- Bonus and boost runs sent `feed_promos: true` and got a spurious warning: only sent when they apply.
- The no-games error told live-fetch CLI users to save a board: it now fits both front doors.
- Games with only dropped feed promos were still fetched from FanDuel: they're left out.
- The board was parsed twice per run: `report_for` hands its parse to `run`.
- The board cache could hand out a stale payload between concurrent requests: it's swapped whole under a lock.
- "Legs to show" took 0.5 and showed an empty table: whole numbers of 1 or more only.

## Worst-case devig as the default

Every leg is priced under all four devig methods and keeps the lowest win probability for its side; the four
methods stay selectable. Terms are in `GLOSSARY.md` (*Devig method*, *Worst-case devig*).

**Done criteria**
- [x] `--devig worst` is the CLI default; `multiplicative`, `additive`, `power`, `shin` still selectable
- [x] Worst case is per leg: the leg is priced whole under each method (book average, promo main-line reprice), and
      the lowest win probability for the leg's side wins
- [x] Where methods disagree on the side, the leg plays the side whose worst case is higher; forced sides
      (over-only lines, promo legs) keep their side
- [x] `/api/options` lists `worst` first and defaults to it; `/api/run` accepts it
- [x] The devig dropdown opens on "Worst case (lowest of four)"; a devig saved before this change moves to worst
      case once, then the user's choice is remembered

**Notes**
- On a two-way market the methods always rank the same way: multiplicative gives the favourite its lowest
  probability, power gives the underdog its lowest, and Shin equals additive. So worst case usually matches
  multiplicative and only differs for legs played on their less likely side or where books disagree.

## Sprint 5: Run notifications

When a fresh run finishes, or any run fails, the app says so: in the page, and on the tab and the desktop when
you're looking elsewhere. Terms are in `GLOSSARY.md` (*Run*, *Odds cache*, *Run notification*). No new
dependencies: the pop-up and the alerts use the browser's own APIs.

**Done criteria**
- [x] The report carries `live_requests`, the number of sportsbook requests the run made live (not from the odds
      cache); canned odds (`PPOPT_ODDS_FILE`) count as live
- [x] A fresh run that finishes shows a pop-up: "Run finished" with the slip count and the best slip's EV; a failed
      run shows "Run failed" with the reason. A cached run shows nothing
- [x] The pop-up is a polite live region, has a close button, auto-dismisses after about 6s when seen, fades in
      (opacity only, none under reduced motion) and follows the ledger style
- [x] If the tab is hidden when the run ends, the pop-up waits for you to come back, the tab title gets a `✓` (or
      `✕`) prefix and the favicon a dot; both clear when the tab is visible again. No flashing
- [x] Settings → Advanced has "Notify me when runs finish" (remembered). Turning it on asks for notification permission; when
      granted, a hidden tab also gets a system notification (one at a time, clicking it focuses the tab and shows
      the report)
- [x] Where system notifications can't work (not a secure context, no `Notification`, mobile), the toggle is
      disabled with a reason; the pop-up and tab mark still work

**Notes**
- Research (GitHub/npm) found sonner, react-hot-toast and react-toastify maintained but unneeded for one pop-up
  kind, and push.js, react-web-notification and favico.js stale; everything is hand-rolled on the Notification and
  Page Visibility APIs (`web/src/notify.ts`, `useRunNotifier.ts`, `RunToast.tsx`, `tabMark.ts`, `systemNotify.ts`).
- System notifications need a secure context (`localhost` counts; a LAN IP over http doesn't) and fail in mobile
  browser tabs, so phones get the pop-up and tab mark only. The tab mark is static: Chrome throttles hidden-tab
  timers to once a minute after five minutes, so a flashing title would stall.
- The pop-up names slips as the report heads them ("Flex 5"), via a shared `slipName`.
- Found on the way: two board uploads at once could fail with a 500 (they shared one temp file, and the meta was
  read mid-write). The new e2e spec's parallel uploads exposed it; each upload now gets its own temp file and the
  meta is written and read under the board lock.

**Review:** done 2026-11-07.

## Sprint 6: Faster fetching, same politeness

A fresh run spent ~1.7 s per sportsbook request, ~1.5 s of it the deliberate pause, and the pause was shared by
both books (largest recorded run: 122 requests, 208 s). This sprint cuts requests the board can't use and lets the
books fetch side by side, each keeping today's rate. Terms are in `GLOSSARY.md` (*Run*, *Pacing*).

**Done criteria**
- [x] The report carries the run's timing: elapsed seconds overall, and live requests and seconds per book; the CLI
      footer and the web report show it
- [x] A run fetches only what the board can use: DraftKings subcategories for stats on the board in that league,
      FanDuel tabs for stats on the board in that game (lines and promo legs alike); the "no props posted yet"
      warning counts only those
- [x] FanDuel MLB `batter-props` and NHL `points-assists` tabs, which map to no stat, are gone from `books.json`
- [x] DraftKings and FanDuel fetch at the same time, each paced on its own (one request every 1–2 s per book);
      cancelling stops both; a failing book still leaves the other's markets
- [x] The progress step names every book still fetching (`DraftKings NHL · FanDuel NBA`); the percentage still
      counts requests across both
- [x] A recorded live run, with its timing, is noted below against the 208 s baseline

**Notes**
- Measured from the odds cache's file times before starting: ~1.7 s per request, ~1.5 s of it the pause, which
  both books shared because they ran one after the other.
- Live run, 2026-11-12 00:38 UTC, fresh (no cache), 7 NBA + 11 NHL games on a 31k-projection board: **89.8 s**,
  DraftKings 20 live requests in 34.9 s, FanDuel 58 in 88.8 s. The old code would have made ~99 requests on this
  board (DraftKings 20, FanDuel 79), ~170 s at 1.72 s each. A busy board needs every DraftKings stat, so the cut
  there is nil; FanDuel's comes mostly from the dead NHL tab across 11 games. FanDuel now sets the run time, at
  ~1.5 s a request, which is Sprint 7's target.
- FanDuel's config is now `"tabs": {tab: {market key: stat}}`, each market listed under the one tab it's fetched
  from (rush+rec yards appears on both NFL receiving and rushing; it's fetched from receiving). This also ends a
  double-parse of that market. The tab contents were read from cached responses, not guessed.
- Each book gets its own view of the run's `Http` (`for_book`), which records its live requests and time, and
  attributes its progress ticks; `Progress` no longer has one "current" book.
- Not test-driven, since thread races don't reproduce on demand: a lock around `Http`'s counters and `Progress`, and
  odds-cache writes made atomic (write aside, then rename).
- Refactor candidate for review: `estimate_requests` repeats the books' pruning rules to estimate up front.

**Review:** done 2026-11-12. `/code-review` (medium) found ten issues, all fixed test-first except where noted:
- "No props posted yet" no longer fires when a book has no market for any stat a game needs: FanDuel warns only
  if it fetched a tab and found nothing; DraftKings only if the league lacks the subcategories its stats come from.
- A board whose stats are all unmapped reports them as Unpriced again, without asking the books for anything.
- The timing line no longer calls a failed or idle book "from the odds cache": each book's timing records live,
  cached and failed, and reads "unavailable", "from the odds cache" or "made no requests" as it should.
- The report carries the timing line as `timing.summary`; the web shows that string, so the wording has one source.
- Timing lists books in book order, whichever finishes first.
- Progress events are sent under `Progress`'s lock, so two books ticking at once can't deliver them out of order.
- A book that breaks stops the other at its next request (`Http.stop`), and its error is the one raised, not the
  other book's `RunCancelled` (which the web stream would have swallowed, leaving the page waiting).
- Not test-driven: the odds-cache temp file is named by process and thread, and removed if the write fails.
- Refactor: `draftkings.needed_subcategories` and `fanduel.needed_tabs` serve both fetching and the up-front estimate.

## Sprint 7: Concurrent requests per book

**Done criteria**
- [x] Each book in `books.json` has `"pacing": {"in_flight": 3, "min_gap": 0.3}`, overridable through `config/`
- [x] A book never has more requests in flight than `in_flight`, nor starts two less than `min_gap` apart
- [x] On a 429 a book is rate-limited: it falls back to one request at a time, 1–2 s apart, retries that request
      once (honouring `Retry-After`), then fails with a warning that names the rate limit. (Changed at review: a
      403 is a refusal, not a rate limit; it gets the same slow-down and one retry, then fails as "refused".)
- [x] A full slate (NFL + NBA + NHL) runs fresh in under 30 s with no rate-limited warning

**Notes**
- Live run, 2026-11-12 01:22 UTC, fresh (no cache), 4 NBA + 13 NHL + 1 NFL game on the same 31k-projection board:
  **14.0 s**, DraftKings 32 live requests in 9.8 s, FanDuel 45 in 13.4 s, no rate-limited warning. Sprint 6's run
  made 78 requests in 89.8 s, nearly all of it the 1-2 s pause per request. (DraftKings went from 20 requests to 32
  because the window now took in an NFL game: its league page plus 12 subcategories.)
- The sources hand each league's requests to `Http` as one batch (`get_many`, answers in order), after the league
  page. `Http` paces each book with its own `Pacer`: at most `in_flight` requests at once, starts at least the gap
  apart. A book with no `pacing`, and any request made by no book (the CLI's PrizePicks fetch), keeps one request
  at a time 1-2 s apart.
- The fast pace measures its gap from one request's start to the next; the slow pace (unpaced books, PrizePicks, a
  book that pushed back) pauses 1-2 s after each request ends, as before.
- Rate-limited: a 429 (at first, a 403 too; see the review) to a book's request slows that book to one at a time, 1-2 s apart, and retries once after
  `Retry-After` (seconds or an HTTP date). Asking for more than 10 s fails the book at once; a second refusal fails
  it too. Either way the warning reads "<book> unavailable: rate-limited: ...". A book that recovered warns that it
  finished one request at a time. Requests made by no book (PrizePicks) are never retried.
- `fetch` now returns the response headers as a third value (for `Retry-After`); fakes returning two still work.
- Tests that passed when first written, guarding behaviour that arrived with the batch: a cancel stops the rest of a
  batch, and a request made by no book isn't retried.

**Review:** done 2026-11-12.
`/code-review` (medium) found ten issues, all fixed, test-first except where noted:
- A book that pushes back holds **all** its requests for the wait (`Retry-After`, or one 1-2 s pause), the retry
  included; before, only the refused request waited and the rest kept going. A request finishing can only push the
  next start later, so it can't cut a hold short (found while fixing this).
- The slow pace pauses after each request ends again (the start-to-start gap had let a slow request swallow its pause).
- Waits end early when the run stops or is cancelled (`Http`'s default sleep is its stop event; `Progress.cancel`
  stops the run's `Http`), and a request that waited checks the run is still going before it's sent.
- Only a 429 is rate-limited. A 403 retried and refused again reads "refused: HTTP 403 from … (blocked, or off a US
  connection)", and a recovered 403 adds no "lower its pacing" warning. A retry failing otherwise (a 500, say)
  reports its own status.
- Bad `pacing` (`in_flight` not a whole number of 1 or more, `min_gap` not 0 or more, either missing) makes that book
  unavailable with a warning saying so, instead of hanging (`in_flight: 0`) or crashing the run.
- Cleanups: one place makes a book's pacer, and a book keeps it for the run (a guard test, written after: a slowed
  book stays slowed when handed a view again); `raise_first_error` in `progress.py` serves both `collect_markets`
  and `get_many`; `Http.timing`'s docstring lists `rate_limited`.
- Live again after the fixes, 01:40 UTC: 14.2 s, DraftKings 32 in 10.0 s, FanDuel 45 in 13.5 s, no warnings.


## Odds cache: one minute

The odds cache now keeps a sportsbook response for one minute instead of five. With fresh runs at ~14 s (Sprint 7),
reusing odds up to five minutes old was no longer worth it: lines move faster than that. Runs within a minute of
each other still share answers. Terms are in `GLOSSARY.md` (*Odds cache*).

**Done criteria**
- [x] A cached response is reused for up to 60 s, then fetched again (`Http`'s default `ttl`)
- [x] `GLOSSARY.md`, `DESIGN.md` and the README say one minute

**Review:** done 2026-11-12.


## Sprint 8: Board from the partner feed

**Goal:** no more saving the board by hand. PrizePicks' partner feed
(`partner-api.prizepicks.com/projections`) serves the same board as the app's feed without DataDome; a probe on
2026-11-13 returned all 29,142 projections in one 1.6 MB page in 1.5 s, with or without browser headers, and the
engine's parser read it unchanged. Its only missing fields are `discount_name` and `discount_percentage` (feed promos
still parse, labelled "promo"). Decision: `docs/adr/0002-board-from-partner-feed.md`; terms in `GLOSSARY.md`
(*Board*, *Partner feed*).

**Done criteria**
- [x] The engine fetches the board from the partner feed over plain HTTP; a block, a non-JSON body or anything that
      isn't a projections feed is a fetch failure with a clear reason
- [x] The stealth browser is gone (`StealthyFetcher`, the `browser` flag)
- [x] CLI: `./getOdds` fetches the board by default; `--pp-file` still overrides; a failed fetch says how to save one
- [x] Web: every run fetches a fresh board first (a progress step) and saves it as the board; when the fetch fails the
      run uses the saved board with a warning saying why and how old it is, or fails asking for an upload when there
      is none
- [x] The page says where the board came from and when (fetched or uploaded); the upload is presented as the fallback;
      the page fetches a board on opening when there is none or it is stale, so the promo-leg picker has lines
- [x] e2e: a canned partner feed stands in for PrizePicks; specs cover a fetched run and the fallback to an upload
- [x] README, ADR 0001 and `DESIGN.md` no longer say the board must be saved by hand

**Notes**
- `prizepicks.fetch` asks for the board with `Http.get_json(url, cache=False)`: never from or into the odds cache,
  still counted as a live request. A dropped connection or timeout is a `FetchError` too; a cancelled run is not.
- `prizepicks.APP_URL` is the website's feed, for the manual fallback steps; `GET /api/options` serves it as
  `board_app_url`.
- `scrapling[fetchers]` stays: Scrapling's plain `Fetcher` won't import without it. The browser binaries
  (`scrapling install`, Playwright deps) are no longer needed.
- Web: every run's first progress step fetches and saves the board, then prices that copy. A failed fetch falls back
  to the saved board with one warning naming the reason, the board's source and age (it replaces the separate
  stale-board warning); with no saved board the run fails asking for an upload. `POST /api/board/fetch` fetches now
  (502 with the reason on failure); the page calls it on opening when there's no board or it's stale.
- Board meta records `source` (`fetched`/`uploaded`; older boards read as uploaded). One write lock covers every
  board write (upload, fetch, a run's fetch) for the whole fetch-and-save, so they never interleave.
- `PPOPT_BOARD_FILE` stands in for the partner feed, as `PPOPT_ODDS_FILE` does for the books. e2e mounts
  `web/e2e/.feed/` read-only and runs three Playwright projects in order: `feed-down` (the fallback specs, feed file
  removed), `feed-up` (writes the shifted fixture board as the feed), then every other spec in parallel.
- Live, 2026-11-14 07:54 UTC, rebuilt app: `POST /api/board/fetch` saved 30,253 projections in 3.6 s; a fresh
  NBA/NHL/NFL run took 14.1 s (DraftKings 8 requests, FanDuel 46), 217 legs, no warnings.

