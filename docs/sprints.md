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
| 4 | Progress and polish | Streamed run steps; motion and interaction pass (Emil Kowalski skills); taste-skill review; dark mode; mobile reflow; config override mount; README leads with the app |

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

**Review:** _pending_
