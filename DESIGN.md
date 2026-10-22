# PrizePicks EV Optimizer — Design

Fetch upcoming standard PrizePicks lines, price each against two-sided sportsbook
odds with the vig removed, rank legs by true win probability, and build the
best slips by EV with at most one leg per game.

## Data sources

| Source | How | Fallback |
|---|---|---|
| PrizePicks | `api.prizepicks.com/projections` via Scrapling stealth browser. Protected by **DataDome**: impersonated HTTP *and* the stealth browser both got 403 in testing, so live fetch is attempted and fails with instructions. | `--pp-file samples/projections.json` saved from a logged-in browser (warns if > 30 min old) |
| FanDuel, DraftKings | Internal JSON feeds via Scrapling's impersonating `Fetcher` (no browser needed), one adapter per book. DK: one request per stat subcategory per league. FD: one request per event per props tab, only for games on the PrizePicks board. | A failing book is a warning; the other still prices |

- Responses cached in `.cache/` for 5 minutes; `--no-cache` forces fresh fetches.
- 1–2 s randomized delay between book requests.
- Adding a book = adding one adapter module.

## Line eligibility

- Standard lines only (no goblins/demons/multi-player combos).
- Each line is priced on its more likely side, restricted to sides PrizePicks allows (`allowed_wager_types: over` lines are over-only).
- Half-point lines only (no pushes).
- Book line must match the PrizePicks line **exactly** (player, stat, value) and have **both sides priced**.
- Player names normalized (strip accents and suffixes, lowercase) and matched exactly; `aliases.json` for exceptions.
- Stat types mapped via a hand-maintained table; unmapped stats (e.g. Fantasy Score) are skipped.
- Unmatched lines are counted; `-v` lists them.
- Defaults: NBA, NFL, MLB, NHL (`--sports`), games starting in the next 24 h (`--hours`).

## Pricing

- Devig per book: multiplicative (default), `--devig power|additive|shin`.
- True probability = mean of per-book devigged probabilities; book disagreement (max − min) is reported.

## Payouts and EV

- Multipliers live in `payouts.json` (verify against the app; they change). `--payouts PATH` overrides.
- Slip outcome distribution = Poisson-binomial over leg probabilities; Flex pays per hit count.
- `--stake` (default $10). EV reported in $ and % of stake.
- Cash entry: `EV = stake × (Σ P(k)·m_k − 1)`.

## Promotions (all mutually exclusive — at most one per run)

| Flag | Effect |
|---|---|
| `--bonus` | Free entry: stake not returned. A tier pays `(m − 1) × stake` profit if `m > 1`, otherwise 0. Losses cost nothing. **Power slips only**: PrizePicks uses a different, undocumented Flex payout structure for bonus entries (believed worse for the player), so Flex is not evaluated in bonus mode. |
| `--boost X` | Every tier with `m > 1` becomes `1 + X·(m − 1)`; tiers ≤ 1x unchanged. No cap (bet limit is handled by `--stake`). |
| `--promoLeg SPORT GAME PLAYER PICK` | Manually entered promo leg (mobile-only promos). Repeatable; at most one promo leg per slip. |

Feed promos (`is_promo` with `flash_sale_line_score`, e.g. `discount_name: taco`) are picked up automatically as promo legs at the discounted line, on by default; `--no-promos` disables them, and they are ignored (with a warning) under `--bonus`/`--boost`.

Combining more than one of these flags is an error.

### Promo legs

```
./getOdds --promoLeg "NFL" "CHI vs NE" "Caleb Williams" "Over 215.5 Pass Yards"
```

- `--promo-leg` is an alias. `PICK` is `Over|Under <line> <stat>` using the stat mapping.
- `GAME` matched to book events by team abbreviations, order-insensitive; `vs`, `@`, `-` accepted.
- No matching event or no two-sided book odds → hard error (never silently dropped).
- Discounted lines rarely match a book line, so promo legs are the one exception to exact matching:
  fit a distribution to each book's main line and its devigged probability, then read the probability
  at the promo line. Average across books. Output flags these as *modelled*.
  - **Poisson** for low-count stats (rebounds, assists, strikeouts, receptions, …): solve λ.
  - **Normal** for large stats (yards, points, combos): solve the mean with σ = cv·mean, where the
    per-stat coefficient of variation is configured (an explicit modelling assumption).
- Insurance/refund promos: out of scope for now.

## Output

- **Ranked legs**: sorted by true probability, with edge vs. a reference slip's per-leg break-even
  (default: the slip with the lowest break-even; `--ref-slip`). Same-game legs are flagged, not hidden.
  Break-even is computed for a cash entry (with boost applied if given), since bonus EV is never negative.
- **Best slips**: every Power 2–6 and Flex 2–6 is evaluated (one leg per game, ≤ 1 promo leg);
  a summary of the top slip per type/size, sorted by EV. `--type`, `--size` filter.
- Table output by default; `--json` for machine output.

### Slip construction

Slip EV is symmetric and non-decreasing in every leg probability, so the optimal N-leg slip is the
top N of the per-game best legs. With promo legs: evaluate the no-promo slip and, for each promo
leg, the slip that includes it plus the top N−1 per-game best non-promo legs from other games.

## Code layout

```
getOdds                 executable wrapper
payouts.json            payout multipliers
aliases.json            player-name aliases
teams.json              team abbreviations / names / nicknames per sport
stats.json              PrizePicks stat_type → canonical stat; promo model + cv per stat
src/ppopt/
  models.py             Leg, PPLine, BookMarket, PromoLeg, Slip
  odds.py               American odds ↔ implied probability, devig methods
  payouts.py            payout tables, boost/bonus adjustment, slip EV, break-even
  slips.py              best-slip construction
  promo_model.py        distribution fitting for discounted promo lines
  matching.py           name normalization, team/stat lookup, --promoLeg parsing
  pricing.py            PrizePicks ↔ book join, per-book devig, promo pricing
  sources/              prizepicks.py, fanduel.py, draftkings.py, cache.py
  cli.py
tests/                  pytest; sources tested against saved responses in samples/
```

## Risks

- Book internal feeds change without notice; scraping is likely against their ToS.
- PrizePicks is behind DataDome; Scrapling may not get through, hence `--pp-file`.
- Payout multipliers change; re-verify `payouts.json` periodically.
