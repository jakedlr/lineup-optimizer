# Glossary

**Game**: One contest between two teams in one sport, starting inside the run's time window. Legs from the same game are correlated, so a slip holds at most one leg per game.

**Matchup**: The two teams playing a game, with no home/away distinction. Its human-readable form, the *matchup label*, lists the teams' abbreviations alphabetically, e.g. `CHI vs NE`.

**Leg**: A single PrizePicks pick (player, stat, line, over/under) together with its true win probability derived from sportsbook odds.

**Promo leg**: A leg on a discounted PrizePicks line, either found in the feed or entered manually. A slip holds at most one.

**Slip**: A PrizePicks entry of 2–6 legs, played as either Power (all legs must hit) or Flex (partial payouts), valued by its expected value at the chosen stake.

**Board**: A snapshot of the lines PrizePicks is offering at a moment in time. Each run fetches a fresh one from the *partner feed*, or reuses one fetched under a minute ago unless it asks for fresh odds; when that fetch fails, the last saved board (an earlier fetch, or one uploaded from the user's browser) is the fallback. Lines move, so a board goes stale; legs are only ever drawn from the current board.
_Avoid_: projections, slate

**Partner feed**: PrizePicks' partner projections endpoint, the board's usual source. It carries the same lines as the board in the PrizePicks app without its bot protection.

**Devig method**: A rule for removing the sportsbook's margin from a two-sided market to get true probabilities: *multiplicative*, *additive*, *power* or *Shin*. On a two-way market Shin and additive agree.

**Worst-case devig**: The default way legs are priced: each leg is priced under every devig method and keeps the lowest win probability for the side it is played on. It is a property of a leg, not of a single market. On a leg's more likely side it is usually the same as multiplicative.

**Run**: One pricing of the current board against the sportsbooks with the chosen settings, ending in a report or a failure. Every run recalculates; nothing about a run's result is reused. A run asks each sportsbook only for markets that could price a line or promo leg on the board.

**Odds cache**: Sportsbook responses kept for one minute and reused by later runs. A run whose every sportsbook request is answered from it is a *cached run*; a run that fetched anything live is a *fresh run*. Only a finished fresh run (or any failed run) raises a run notification.

**Pacing**: How fast a run may send requests to one sportsbook: how many at once and how far apart. Each sportsbook is paced on its own. A sportsbook that pushes back is *rate-limited* and falls back to one request at a time, slowly, for the rest of the run. Board requests to the partner feed are paced too: one at a time, across runs, backing off like a sportsbook's.

**Auto run**: A run the app starts by itself on the quarter hour (:00, :15, :30, :45) while *auto runs* are switched on, whether or not the page is open. A failed board fetch switches auto runs off.

**Qualifying leg**: A leg whose edge meets an alert tier's threshold. At most one per game counts, so a count of qualifying legs is a slip that could be played.

**Run notification**: The alert that a run has ended: a pop-up in the page, and while the tab is in the background, a mark on the tab and (when allowed) a system notification.
