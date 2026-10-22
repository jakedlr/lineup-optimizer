# PrizePicks EV Optimizer

Finds the PrizePicks picks with the best expected value (EV) by comparing them against what the
big sportsbooks think will happen, then builds the best lineups from them.

> **Disclaimer.** This project is for educational and informational purposes only. Nothing it
> outputs is financial, betting or any other kind of advice, and its probabilities are estimates
> that can be wrong. I do not condone or encourage gambling. If you choose to play, follow the laws
> where you live, only risk money you can afford to lose, and if gambling stops being fun, help is
> available at 1-800-GAMBLER (US).

---

## How it works

PrizePicks doesn't show odds. It just offers lines, like *Caleb Williams over/under 246.5 pass
yards*. Sportsbooks such as FanDuel and DraftKings price those same lines (e.g. Over −111 /
Under −113), and those prices reveal how likely each outcome is. This tool uses that:

1. **Get the PrizePicks board.** It reads every upcoming standard line in the leagues you choose.
2. **Get the sportsbook prices.** It fetches matching player props from FanDuel and DraftKings.
3. **Remove the bookmaker's cut ("vig").** Sportsbook prices on both sides always add up to more
   than 100%. That extra is their margin. Removing it leaves a fair probability for each side.
   Only lines priced on **both** sides are used, because a one-sided price hides how much margin
   is baked in.
4. **Score each pick.** Every PrizePicks line gets a win probability (averaged across books) and
   an *edge*: how far that probability is above what you need to break even.
5. **Build lineups.** Using PrizePicks' payout table, it finds the highest-EV Power and Flex
   lineup for every size, using **at most one pick per game** so that picks don't influence
   each other.

Promotions are supported too: free/bonus entries, payout boosts, and discounted "promo" lines
such as tacos.

## Stack

| Piece | Why it was chosen |
|---|---|
| **Python 3.11+** | Readable, ubiquitous, and the standard library covers all of the maths (no NumPy/SciPy needed). |
| **[Scrapling](https://github.com/D4Vinci/Scrapling)** | Fetches the sportsbooks' internal JSON feeds with browser-like TLS fingerprints, which plain `requests` gets blocked on. It also provides a stealth browser for sites with heavier bot protection. |
| **Sportsbooks' internal JSON feeds** (FanDuel, DraftKings) | Free and detailed, and far more stable than scraping web pages. FanDuel's prop prices are widely seen as sharp. Using two books adds a cross-check. A paid odds API was considered and set aside on cost. |
| **PrizePicks projections feed** | The same JSON the PrizePicks website uses. It includes line types (standard/goblin/demon), allowed sides, and promo lines. |
| **argparse** | Standard-library CLI parsing, with built-in support for mutually exclusive options (used for promotions). |
| **pytest** | Simple tests. All maths was written test-first, and the scrapers are tested against saved real responses in `tests/fixtures/`, so the suite runs offline. |
| **JSON config files** | Payouts, stat names, team names and book markets change over time. Keeping them in editable files means most fixes need no code changes. |

## Setup

### Requirements

- **Python 3.11 or newer** (developed on 3.14).
- **Linux, macOS, or Windows via WSL.** `./getOdds` is a bash script. On native Windows, run
  `python -m ppopt.cli` with `src` on `PYTHONPATH` instead.
- **A US network location where FanDuel and DraftKings load normally** (no VPN). Both block some
  regions. Odds are read from their New Jersey hosts by default (`"state"` in `books.json`).
- **A browser logged into PrizePicks**, for saving the board (see below).

### Install

```bash
git clone https://github.com/jakedlr/lineup-optimizer.git
cd lineup-optimizer
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest            # optional: check everything works
```

Optional: install the stealth browser, which is only used to *try* fetching PrizePicks directly:

```bash
sudo .venv/bin/python -m playwright install-deps chromium
.venv/bin/scrapling install
```

### Getting the PrizePicks board

PrizePicks is protected by anti-bot software (DataDome) that blocks automated requests, including
the stealth browser in testing. The reliable route is to save the board from your own browser:

1. Log in at <https://app.prizepicks.com>.
2. In the same browser, open
   `https://api.prizepicks.com/projections?per_page=1000&single_stat=true&game_mode=pickem`
   and complete the "verify you're human" check if one appears.
3. Press **Ctrl+S** and save it as `samples/projections.json` in this folder. On WSL the path is
   `\\wsl.localhost\Ubuntu\home\<you>\lineup-optimizer\samples\projections.json`
   (adjust for your distro and clone location).

   If that page won't load: open DevTools (**F12**) on app.prizepicks.com, go to **Network**,
   filter for `projections`, refresh, then right-click the request → **Copy → Copy response**
   and paste it into that file.

Lines move during the day, so re-save before each session. The tool warns you when the file is
more than 30 minutes old.

## Usage

```bash
./getOdds --pp-file samples/projections.json
```

If you leave out `--pp-file`, it tries to fetch PrizePicks directly and explains what to do if
that's blocked.

### Options

**Data**

| Option | Default | Meaning |
|---|---|---|
| `--pp-file PATH` | – | PrizePicks board saved from your browser |
| `--sports LIST` | `NFL,NBA,NHL,MLB` | Comma-separated leagues |
| `--hours N` | `24` | Only games starting within the next N hours |
| `--no-cache` | off | Ignore cached odds (cached for 5 minutes in `.cache/`) and fetch fresh |

**Pricing**

| Option | Default | Meaning |
|---|---|---|
| `--stake N` | `10` | Entry amount in dollars. EV is shown in dollars and as a % of this |
| `--devig METHOD` | `multiplicative` | How the vig is removed: `multiplicative`, `additive`, `power`, `shin` |
| `--payouts PATH` | `payouts.json` | Use a different payout table |

**Promotions.** Only one kind can be used per run, and combining them is an error.

| Option | Meaning |
|---|---|
| `--bonus` | Free/bonus entry: your stake isn't returned, so a win pays only the profit. Power lineups only (see below) |
| `--boost X` | Lineup payout boost, e.g. `--boost 1.4` turns a 6x payout into 8x |
| `--promoLeg SPORT GAME PLAYER PICK` | Add a promo pick by hand, e.g. one only shown in the mobile app. Repeatable; `--promo-leg` also works |
| `--no-promos` | Ignore promo lines that appear in the PrizePicks feed (e.g. tacos) |

**Output**

| Option | Default | Meaning |
|---|---|---|
| `--type power\|flex` | both | Only show this lineup type |
| `--size 2-6` | all | Only show this lineup size |
| `--ref-slip TYPEN` | lowest break-even | Lineup whose break-even sets each pick's *edge*, e.g. `flex6`, `power2` |
| `--top N` | `25` | Number of picks to list |
| `--json` | off | Machine-readable output |
| `-v` | off | List every PrizePicks line that couldn't be priced, and why |

### Examples

```bash
# Tonight's NBA only, as 5-pick Flex
./getOdds --pp-file samples/projections.json --sports NBA --hours 8 --type flex --size 5

# A $20 boosted lineup
./getOdds --pp-file samples/projections.json --stake 20 --boost 1.4

# A $5 free entry
./getOdds --pp-file samples/projections.json --stake 5 --bonus

# A mobile-only promo, entered by hand
./getOdds --pp-file samples/projections.json \
  --promoLeg "NFL" "CHI vs NE" "Caleb Williams" "Over 215.5 Pass Yards"
```

`GAME` accepts abbreviations or names in either order (`CHI vs NE`, `NE @ CHI`,
`Bears - Patriots`). `PICK` is `Over|Under <line> <stat>`, using PrizePicks' stat names
(`More`/`Less` work too).

### Reading the output

- **Prob**: the estimated chance the pick wins, after removing the vig.
- **Edge**: Prob minus the per-pick break-even of the reference lineup (shown at the top).
  Positive means the pick beats break-even for that lineup. For `--bonus`, break-even is still
  calculated as a regular cash entry, since a free entry never loses money.
- **Books**: each book's probability. *books differ* flags a gap of 3 percentage points or more.
- **Notes**: *same game* marks a pick from a game already listed higher up. It's shown, but
  never put in the same lineup. *taco (modelled)* marks an estimated promo line (see below).
- **Best slips**: the top lineup for each type and size, sorted by EV.
- **Unpriced lines**: PrizePicks lines skipped and why. `-v` lists them.

## Decisions and their trade-offs

These are deliberate choices, not oversights:

- **One pick per game per lineup.** Picks from the same game are correlated, which the EV maths
  doesn't model, so lineups never contain two.
- **Two-sided prices only.** A one-sided price (e.g. "250+ yards") hides how much vig it carries,
  so it's never used.
- **Exact line matches only.** If PrizePicks says 246.5 and the book says 243.5, the line is
  skipped rather than guessed. The only exception is promo lines (below).
- **Half-point lines only.** Whole-number lines can push, which shrinks the lineup at a lower
  payout. That's complex enough to leave out, so they're skipped.
- **Standard lines only.** Goblins, demons and multi-player combos are excluded.
- **One side per line.** Each line is listed on its more likely side, or on the only side
  PrizePicks allows for over-only lines.
- **Books are averaged.** A pick's probability is the average across the books that price that
  exact line. Disagreement is shown, but a pick is never dropped for it.
- **Bonus entries are Power-only.** PrizePicks pays Flex lineups on bonus entries with a
  different, undocumented structure that's believed to be worse for the player, so Flex is
  not considered with `--bonus`.
- **Boosts multiply the profit.** A boost of X turns payout `m` into `1 + X × (m − 1)`.
  On Flex lineups, only levels paying more than 1x are boosted.
- **One promotion per lineup.** PrizePicks allows one, so `--bonus`, `--boost` and `--promoLeg`
  can't be combined. Feed promos are switched off when `--bonus` or `--boost` is used, and a
  lineup holds at most one promo pick.
- **Feed promos are on by default.** Taco and other promo lines in the PrizePicks feed are used
  at their discounted line unless you pass `--no-promos`.
- **Promo lines are estimated.** A discounted line (e.g. 215.5 when the books say 246.5) has no
  matching book price, so its probability is estimated from the book's main line using a
  standard distribution for that stat: Poisson for small counts like rebounds, and a normal
  curve for yards and points. The spread assumed for each normal stat is a judgment call,
  set in `stats.json` (`cv`). These picks are labelled *(modelled)*.
- **Insurance/refund promos aren't supported** yet.

## Configuration files

| File | What it holds | When to edit |
|---|---|---|
| `payouts.json` | Power/Flex multipliers by lineup size and number of hits | When PrizePicks changes payouts. Check against the app periodically |
| `stats.json` | PrizePicks stat names → internal stats, and each stat's promo model | To support a new stat, or tune a promo spread (`cv`) |
| `books.json` | Each book's market names → internal stats, and the regional host (`state`) | When a book renames a market or you add a stat |
| `teams.json` | Team abbreviations, names and nicknames | When a team relocates or renames |
| `aliases.json` | Player names that differ between PrizePicks and the books | When `-v` shows a player as *no book market* who clearly exists |

## Limitations

- The sportsbooks' and PrizePicks' internal feeds are undocumented and can change without
  notice. When one changes, usually only that book's file in `src/ppopt/sources/` needs updating.
  Automated access to these sites is likely against their terms of service.
- FanDuel coverage is narrower for NHL and MLB. Only markets seen and verified so far are mapped.
- Estimates are only as good as the sportsbooks' prices and the assumptions above.

## Development

```bash
.venv/bin/python -m pytest
```

`DESIGN.md` has the full design. Code is in `src/ppopt/`: `odds.py` (vig removal),
`payouts.py` (EV maths), `slips.py` (lineup building), `promo_model.py` (promo estimates),
`matching.py`/`pricing.py` (joining PrizePicks to the books), `sources/` (data fetching) and
`cli.py`.
