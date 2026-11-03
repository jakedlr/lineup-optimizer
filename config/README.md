# Config overrides

Drop an edited copy of any of these files here to use it instead of the built-in one:

`payouts.json` · `books.json` · `stats.json` · `teams.json` · `aliases.json`

Start from the file of the same name in the project root. Files here are ignored by git.
The Docker app mounts this folder read-only, and the CLI reads it too. Changes apply on the next run, so
there's no rebuild or restart.
