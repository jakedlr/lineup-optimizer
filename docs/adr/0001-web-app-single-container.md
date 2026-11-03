# Web app and CLI share one engine, shipped as a single container

The optimizer gains a browser UI so users can drop a board and press Run instead of composing CLI flags. We kept the `ppopt` engine as the single source of truth and put two thin front doors on it: the existing `./getOdds` CLI and a FastAPI service that serves a React SPA, both built into one Docker image for local, single-user use. The app is not hosted, because FanDuel and DraftKings geo-block requests and must be reached from the user's own US connection.

The Playwright/Chromium stealth browser is excluded from the image (~1 GB, and DataDome blocks it in practice), so the app requires an uploaded board; it never fetches PrizePicks itself.

## Considered options

- **Streamlit / server-rendered htmx**: no JS build step, but a poor fit for the interaction and motion work the UI is meant to have.
- **Separate frontend and API containers**: more moving parts for no benefit to a single local user.
- **Replace the CLI with the app**: the CLI costs almost nothing to keep since both call the same engine.
