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
