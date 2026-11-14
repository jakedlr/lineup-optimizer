# Auto runs and run settings live on the server

Auto runs (a run every quarter hour, then a phone alert through ntfy in Sprint 10) are only useful when nobody is
looking at the page, so the schedule runs inside the app's server process rather than in a browser tab, which stops
when the tab closes, the laptop sleeps or the browser throttles timers. That puts run settings on the server too:
they used to live only in the browser's storage, where a scheduled run can't read them. The server also keeps the
latest run's report so an auto run's result is there when the page next opens.

## Consequences

- The app is no longer stateless between requests: it holds one schedule thread, one run at a time, and three small
  files on the data volume (run settings, auto-run state, latest report).
- View preferences that only change what one browser shows stay in that browser.
- Auto runs only happen while the container is up; quarter marks missed while it was down are not caught up.
