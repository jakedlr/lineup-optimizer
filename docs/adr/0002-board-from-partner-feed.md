# Board from the partner feed

PrizePicks' consumer feed (`api.prizepicks.com/projections`) sits behind DataDome, which blocked every automated
request we tried, so ADR 0001 had the app never fetch PrizePicks and users save the board by hand. The partner feed
(`partner-api.prizepicks.com/projections`) serves the same projections, in the same JSON:API shape, without that
protection (probed 2026-11-13: the full board in one page, plain HTTP, no headers needed; other open-source tools
have used it since early 2026). Every run now fetches the board from it, and the app and CLI no longer need a browser
of any kind.

## Consequences

- The endpoint is undocumented and could be closed or protected at any time, so uploading a board (`--pp-file` on the
  CLI) stays as the fallback, and a manual run whose fetch fails falls back to the saved board with a warning.
- The partner feed omits `discount_name`/`discount_percentage`, so feed promos are labelled generically. Whether it
  also omits promo projections entirely is unconfirmed; compare with the app's feed while a promo is posted.
- This supersedes ADR 0001's "the app never fetches PrizePicks itself"; the rest of 0001 stands.
