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
