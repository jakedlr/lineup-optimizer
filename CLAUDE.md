# PrizePicks EV Optimizer

One engine (`src/ppopt/`) behind two front doors: the `./getOdds` CLI and a FastAPI + React app shipped as one
Docker image. Terms follow `GLOSSARY.md`; the architecture is `docs/adr/0001-web-app-single-container.md`; the build
log and each sprint's done criteria are in `docs/sprints.md`.

## Skills

These come from external repos (install steps: README → References). Reach for them by the work at hand:

- **UI motion or interaction** (anything that moves, presses, opens, or arrives in `web/src`): `emil-design-eng`.
  The rest of Emil Kowalski's set (`review-animations`, `animation-performance`, `mobile-native`, `break-ui`) covers
  narrower cases.
- **UI look** (type, colour, layout, a new screen or block): `taste-skill:design-taste-frontend`, app-screen run.
  The dealt style is **achromatic-ledger** (seed 931360211, sheet in `.taste-skill/direction.json`); keep it. Gate
  with its `lint.mjs --app web/src` and `inspect.mjs --app http://localhost:8000`, pointing the inspector at
  Playwright's browser: `CHROME_PATH=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | head -1)`.
  Where the two disagree, the app-screen rule wins: a working screen performs no entrances, and a result arriving
  may fade.
- **Domain terms, `GLOSSARY.md`, or an ADR**: `mattpocock-skills:domain-modeling`.
- **Planning a sprint or stress-testing a design**: `mattpocock-skills:grilling`.
- **Editing this file or another agent-facing doc**: `mattpocock-skills:writing-for-agents`.

## Working here

- Test-first: a failing test, then the change. UI behaviour gets a Vitest test; layout and anything CSS decides gets
  a Playwright spec in `web/e2e/`.
- `make e2e` runs a separate compose project on port 8001 with canned odds (`tests/fixtures/markets.json`) and a
  canned partner feed (`web/e2e/.feed/`), so it needs neither live books nor a US connection. Specs shift the
  fixture board's start times to two hours from now. Only one run goes at a time, so specs run serially: import
  `test` from `e2e/test.ts` (it switches auto runs off and restores run settings after each test), and use
  `holdFeed()` from `e2e/board.ts` to hold a run mid-fetch.
- Done means `make test` and `make e2e` green, `make up` rebuilt, `docs/sprints.md` updated, then commit and push to
  `main` (no branches in this project).
- Live sportsbook feeds drift. Before changing `books.json` because a market looks missing, check the market's
  parent category: next-day props are often simply not posted yet, and the run's warnings say so.
