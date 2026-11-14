import { useEffect, useMemo, useState } from 'react'
import { getBoardLines, type BoardLine, type PromoLeg, type Side } from './api'
import { pick } from './format'
import { Segmented } from './Segmented'
import type { Promotion } from './settings'

interface Props {
  promotion: Promotion
  onChange: (next: Promotion) => void
  sports: string[]
  hours: number | null
  boardKey: string | null // changes whenever a new board is saved
}

const MAX_RESULTS = 8
const isHalfPoint = (n: number) => Number.isFinite(n) && Math.abs(n % 1) === 0.5

function matches(line: BoardLine, query: string) {
  const hay = `${line.player} ${line.stat_label} ${line.sport} ${line.matchup}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word))
}

function LegPicker({ sports, hours, boardKey, onAdd }: Omit<Props, 'promotion' | 'onChange'> & { onAdd: (l: PromoLeg) => void }) {
  // Each fetch result is tagged with what it was fetched for, so stale results are simply ignored.
  const [fetched, setFetched] = useState<{ key: string; lines?: BoardLine[]; error?: string } | null>(null)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<BoardLine | null>(null)
  const [side, setSide] = useState<Side>('over')
  const [promoLine, setPromoLine] = useState('')

  const sportsKey = sports.join(',')
  const requestKey = boardKey && sportsKey && hours !== null ? `${boardKey}|${sportsKey}|${hours}` : null
  useEffect(() => {
    if (!requestKey) return
    let live = true
    getBoardLines(sportsKey.split(','), hours!)
      .then((lines) => live && setFetched({ key: requestKey, lines }))
      .catch((e) => live && setFetched({ key: requestKey, error: e instanceof Error ? e.message : String(e) }))
    return () => {
      live = false
    }
  }, [requestKey, sportsKey, hours])

  const current = fetched?.key === requestKey ? fetched : null
  const lines = current?.lines ?? null
  const failed = current?.error ?? null

  const results = useMemo(
    () => (lines && query.trim() ? lines.filter((l) => matches(l, query)).slice(0, MAX_RESULTS) : []),
    [lines, query],
  )

  const choose = (l: BoardLine) => {
    setChosen(l)
    setPromoLine(String(l.line))
    setSide('over')
  }

  const lineValue = Number(promoLine)
  const lineOk = promoLine.trim() !== '' && isHalfPoint(lineValue)

  const add = () => {
    if (!chosen || !lineOk) return
    onAdd({ ...chosen, side, line: lineValue })
    setChosen(null)
    setQuery('')
  }

  if (!boardKey) return <p className="muted small">No board to pick promo legs from yet.</p>
  if (failed) return <p className="warn">Couldn't read lines from the board: {failed}</p>

  return (
    <div className="picker">
      <label className="field">
        <span>Find a line on the board</span>
        <input
          type="search"
          placeholder={lines ? `Player or stat, e.g. "embiid points" (${lines.length.toLocaleString('en-US')} lines)` : 'Loading lines…'}
          value={query}
          disabled={!lines}
          onChange={(e) => {
            setQuery(e.target.value)
            setChosen(null)
          }}
        />
      </label>

      {!chosen && query.trim() && lines && (
        results.length === 0 ? (
          <p className="muted small">No lines on the board match. Check the leagues and hours ahead above.</p>
        ) : (
          <ul className="results" role="listbox" aria-label="Board lines">
            {results.map((l) => (
              <li
                key={`${l.player}|${l.stat_label}|${l.line}|${l.matchup}`}
                role="option"
                aria-selected={false}
                tabIndex={0}
                onClick={() => choose(l)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), choose(l))}
              >
                <span>
                  <strong>{l.player}</strong> · {l.stat_label} {l.line}
                </span>
                <span className="muted small">
                  {l.sport} {l.matchup}
                </span>
              </li>
            ))}
          </ul>
        )
      )}

      {chosen && (
        <div className="chosen">
          <p>
            <strong>{chosen.player}</strong> · {chosen.stat_label}{' '}
            <span className="muted small">
              board line {chosen.line} · {chosen.sport} {chosen.matchup}
            </span>
          </p>
          <div className="chosen-row">
            <Segmented<Side>
              label="Side"
              value={side}
              options={[
                { value: 'over', label: 'Over' },
                { value: 'under', label: 'Under' },
              ]}
              onPick={setSide}
            />
            <label className="field inline">
              <span>Promo line</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.5"
                value={promoLine}
                onChange={(e) => setPromoLine(e.target.value)}
              />
            </label>
            <button type="button" className="secondary" disabled={!lineOk} onClick={add}>
              Add promo leg
            </button>
          </div>
          {!lineOk && <p className="warn">Promo lines are half-point lines, e.g. {Math.floor(lineValue || chosen.line)}.5.</p>}
        </div>
      )}
    </div>
  )
}

export function PromoPanel({ promotion, onChange, sports, hours, boardKey }: Props) {
  const set = (patch: Partial<Promotion>) => onChange({ ...promotion, ...patch })
  const feedPromosApply = promotion.kind !== 'bonus' && promotion.kind !== 'boost'

  return (
    <section className="promo" aria-labelledby="promo-h">
      <div className="promo-head">
        <h2 id="promo-h" className="label">
          Promotion
        </h2>
        <Segmented<Promotion['kind']>
          label="Promotion"
          value={promotion.kind}
          options={[
            { value: 'none', label: 'None' },
            { value: 'bonus', label: 'Bonus entry' },
            { value: 'boost', label: 'Boost' },
            { value: 'legs', label: 'Promo legs' },
          ]}
          onPick={(kind) => set({ kind })}
        />
      </div>

      {promotion.kind === 'bonus' && (
        <p className="muted small">Free entry: your stake isn't returned, so a win pays only the profit. Power slips only.</p>
      )}

      {promotion.kind === 'boost' && (
        <label className="field inline">
          <span>Boost ×</span>
          <input
            type="number"
            inputMode="decimal"
            min="1"
            step="0.1"
            value={promotion.boost}
            onChange={(e) => set({ boost: e.target.value })}
          />
          <span className="muted small">Multiplies the slip payout, e.g. 1.4 turns 6x into 8.4x.</span>
        </label>
      )}

      {promotion.kind === 'legs' && (
        <>
          <p className="muted small">
            A discounted pick from PrizePicks, e.g. one only shown in the app. A slip holds at most one.
          </p>
          {promotion.legs.length > 0 && (
            <ul className="promo-legs" aria-label="Promo legs">
              {promotion.legs.map((l, i) => (
                <li key={`${l.player}|${l.stat_label}|${l.side}|${l.line}`}>
                  <span>{`${l.player} · ${pick(l)}`}</span>
                  <span className="muted small">
                    {l.sport} {l.matchup}
                  </span>
                  <button
                    type="button"
                    className="link"
                    aria-label={`Remove ${l.player} ${pick(l)}`}
                    onClick={() => set({ legs: promotion.legs.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <LegPicker
            sports={sports}
            hours={hours}
            boardKey={boardKey}
            onAdd={(leg) => set({ legs: [...promotion.legs, leg] })}
          />
        </>
      )}

      <label className="check">
        <input
          type="checkbox"
          checked={promotion.feedPromos && feedPromosApply}
          disabled={!feedPromosApply}
          onChange={(e) => set({ feedPromos: e.target.checked })}
        />
        <span>
          Include promo lines from the board <span className="muted small">(e.g. tacos)</span>
          {!feedPromosApply && <span className="muted small"> · not used with a bonus or boost</span>}
        </span>
      </label>
    </section>
  )
}
