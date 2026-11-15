import { Fragment } from 'react'
import { AlertNote } from './AlertNote'
import type { AlertOutcome, Leg, Report } from './api'
import {
  ago,
  bookAbbr,
  minutesSince,
  money,
  pct,
  pick,
  signedMoney,
  signedPct,
  signOf,
  slipName,
  STALE_MINUTES,
} from './format'
import { Segmented } from './Segmented'
import type { Settings } from './settings'
import { useNow } from './useNow'

type SlipFilter = Pick<Settings, 'slipType' | 'slipSize'>

interface Props extends SlipFilter {
  report: Report
  /** Which run it came from: "Auto run · 14:15", "Run · 14:08", "Previous run · 09:53". */
  label?: string
  /** When that run started, for the report's age. */
  at?: string
  /** How this run's alert went, when it sent one and the server has said. */
  alert?: AlertOutcome | null
  top: number
  onFilter: (f: Partial<SlipFilter>) => void
  /** No longer the latest word: a run is going, or one failed since. The report dims. */
  stale?: boolean
  /** A run is going that will replace it. */
  busy?: boolean
  /** The report the page opened on: it is simply there, without the fade a new result arrives with. */
  opened?: boolean
}

/** Green for a gain, nothing for a figure that prints as zero. */
const signClass = (s: -1 | 0 | 1, below: string) => (s > 0 ? 'pos' : s < 0 ? below : '')

/** The run settings a report was made with, as one line: "$10 stake · worst-case devig · NFL, NBA · next 24 h". */
function settingsLine(s: Report['settings']) {
  const devig = s.devig === 'worst' ? 'worst-case devig' : `${s.devig} devig`
  return [`${money(s.stake)} stake`, s.mode !== 'cash' && s.mode, devig, s.sports.join(', '), `next ${s.hours} h`]
    .filter(Boolean)
    .join(' · ')
}

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0') // taste-skill-ignore: a timestamp in the file name
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}`
}

function download(report: Report) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `ppopt-report-${stamp()}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function LegLine({ leg }: { leg: Leg }) {
  return (
    <li className="slip-leg">
      <span className="num">{pct(leg.prob)}</span>
      <span className="tag">{leg.sport}</span>
      <span className="muted">{leg.matchup}</span>
      <span className="who" title={leg.player}>
        {leg.player}
      </span>
      <span className="pick">
        {pick(leg)}
        {leg.promo_type && <span className="badge">{leg.promo_type}</span>}
      </span>
    </li>
  )
}

function BestSlips({ report, slipType, slipSize, onFilter }: Omit<Props, 'top' | 'label'>) {
  const sizes = [...new Set(report.slips.map((s) => s.size))].sort()
  const shown = report.slips.filter(
    (s) => (slipType === 'all' || s.type === slipType) && (slipSize === 'all' || s.size === slipSize),
  )
  return (
    <section aria-labelledby="slips-h" className="block">
      <div className="block-head">
        <h2 id="slips-h">Best Slips</h2>
        {report.slips.length > 0 && (
          <div className="filters">
            <Segmented
              label="Slip type"
              value={slipType}
              options={[
                { value: 'all', label: 'All' },
                { value: 'power', label: 'Power' },
                { value: 'flex', label: 'Flex' },
              ]}
              onPick={(v) => onFilter({ slipType: v })}
            />
            <Segmented<'all' | number>
              label="Slip size"
              value={slipSize}
              options={[{ value: 'all', label: 'All' }, ...[2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))]}
              onPick={(v) => onFilter({ slipSize: v })}
            />
          </div>
        )}
      </div>
      {report.slips.length === 0 ? (
        <p className="muted">None: not enough distinct games.</p>
      ) : shown.length === 0 ? (
        <p className="muted">
          No slips match this filter.{sizes.length > 0 && ` This run has sizes ${sizes.join(', ')}.`}
        </p>
      ) : (
        <div className="slips">
          {shown.map((s) => (
            <article key={`${s.type}${s.size}`} className="slip">
              <header>
                <h3>{slipName(s)}</h3>
                <span className={`num ${signClass(signOf(s.ev, 2), 'neg')}`}>{signedMoney(s.ev)}</span>
                <span className="muted num small">{signedPct(s.ev_pct)}</span>
              </header>
              <ul>
                {s.legs.map((l) => (
                  <LegLine key={`${l.game}|${l.player}|${l.stat}|${l.side}`} leg={l} />
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

const bookPrice = (p: number) => (p * 100).toFixed(1)

function TopLegs({ report, top }: { report: Report; top: number }) {
  const legs = report.legs.slice(0, top)
  const ref = report.ref_slip
  const refName = slipName({ type: ref.type === 'flex' ? 'flex' : 'power', size: ref.size })
  // Clears as its edge figure reads: a "0.0%" is break-even, which clears; a leg with no edge doesn't.
  const clears = (l: Leg) => l.edge !== undefined && signOf(l.edge, 1, 100) >= 0
  const firstBelow = legs.findIndex((l) => !clears(l))
  // Every book that priced a leg, in one order, so each keeps its own column of figures.
  const books = [...new Set(report.legs.flatMap((l) => Object.keys(l.books)))].sort()
  return (
    <section aria-labelledby="legs-h" className="block">
      <h2 id="legs-h">Top Legs</h2>
      {report.legs.length === 0 ? (
        <p className="muted">No legs priced in this window.</p>
      ) : (
        <>
          <p className="muted small">
            {report.legs.filter(clears).length} of {report.legs.length} legs clear the {refName} break-even ({pct(ref.break_even)})
          </p>
          <div className="table-wrap">
            <table className="legs-table">
              <thead>
                <tr>
                  <th className="num">Edge</th>
                  <th className="num">Prob</th>
                  <th className="c-sport">Sport</th>
                  <th className="c-matchup">Matchup</th>
                  <th>Player</th>
                  <th>Pick</th>
                  <th className="c-books">
                    <span className="visually-hidden">Books: </span>
                    {books.map((b) => (
                      <span key={b} className="book num">
                        {bookAbbr(b)}
                      </span>
                    ))}
                  </th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {legs.map((l, i) => {
                  const notes = [
                    l.promo_type && `${l.promo_type}${l.modelled ? ' (modelled)' : ''}`,
                    l.same_game && 'same game',
                    l.disagreement >= 0.03 && `books differ ${(l.disagreement * 100).toFixed(1)}%`,
                  ].filter((n): n is string => !!n)
                  const priced = books.filter((b) => b in l.books).map((b) => `${bookAbbr(b)} ${bookPrice(l.books[b])}`)
                  return (
                    <Fragment key={`${l.game}|${l.player}|${l.stat}|${l.side}|${l.line}`}>
                      {i === firstBelow && (
                        <tr className="below-row">
                          <td colSpan={8}>
                            Below the {refName} break-even, {pct(ref.break_even)} per leg
                          </td>
                        </tr>
                      )}
                      <tr>
                        {l.edge === undefined ? (
                          <td className="num c-edge muted">—</td>
                        ) : (
                          <td className={`num c-edge ${signClass(signOf(l.edge, 1, 100), 'muted')}`}>{signedPct(l.edge)}</td>
                        )}
                        <td className="num c-prob">{pct(l.prob)}</td>
                        <td className="c-sport">{l.sport}</td>
                        <td className="nowrap c-matchup">{l.matchup}</td>
                        <td className="c-player">
                          <span className="who">{l.player}</span>
                          <span className="sub">
                            {l.sport} · {l.matchup}
                          </span>
                        </td>
                        <td className="c-pick">{pick(l)}</td>
                        <td className="nowrap muted small c-books">
                          {books.map((b) =>
                            b in l.books ? (
                              <span key={b} className="book num">
                                {bookPrice(l.books[b])}
                              </span>
                            ) : (
                              <span key={b} className="book num">
                                –
                              </span>
                            ),
                          )}
                        </td>
                        <td className="muted small c-notes">{notes.join(', ')}</td>
                        <td className="c-meta">{[l.sport, l.matchup, ...priced, ...notes].join(' · ')}</td>
                      </tr>
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function Unpriced({ report }: { report: Report }) {
  const counts = Object.entries(report.unmatched).sort((a, b) => b[1] - a[1])
  const total = counts.reduce((n, [, c]) => n + c, 0)
  return (
    <section aria-labelledby="unpriced-h" className="block">
      <h2 id="unpriced-h">Unpriced</h2>
      {total === 0 ? (
        <p className="muted">Every line in the window was priced.</p>
      ) : (
        <>
          <p className="muted small">{total.toLocaleString('en-US')} lines on the board had no usable two-sided book price.</p>
          <ul className="counts">
            {counts.map(([reason, n]) => (
              <li key={reason}>
                <span className="num">{n}</span> {reason}
              </li>
            ))}
          </ul>
          <details>
            <summary>Show lines</summary>
            <div className="table-wrap">
              <table className="unpriced-table">
                <tbody>
                  {report.unmatched_lines.map((u, i) => (
                    <tr key={i}>
                      <td>{u.sport}</td>
                      <td className="nowrap u-player">{u.player}</td>
                      <td>{u.stat}</td>
                      <td className="num">{u.line}</td>
                      <td className="muted small u-reason">{u.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  )
}

function Age({ at }: { at: string }) {
  const minutes = minutesSince(at, useNow())
  return <span className={minutes > STALE_MINUTES ? 'warn' : undefined}>{ago(minutes)}</span>
}

export function ReportView({ report, label, at, alert, top, slipType, slipSize, onFilter, stale, busy, opened }: Props) {
  return (
    <div className="report" data-stale={stale ? '' : undefined} aria-busy={busy || undefined} data-opened={opened ? '' : undefined}>
      <div className="report-head">
        <p className="muted small">
          {label && (
            <>
              <span className="run-mark">{label}</span>
              {' · '}
            </>
          )}
          {at && (
            <>
              <Age at={at} />
              {' · '}
            </>
          )}
          <span>{settingsLine(report.settings)}</span>
          {/* A failed alert is set on its own line below (index.css), so it never runs into the settings. */}
          {alert && (alert.sent ? <> · <AlertNote alert={alert} /></> : <AlertNote alert={alert} />)}
        </p>
        <button type="button" className="secondary small" onClick={() => download(report)}>
          Download JSON
        </button>
      </div>
      {report.warnings.length > 0 && (
        <ul className="warnings">
          {report.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <BestSlips report={report} slipType={slipType} slipSize={slipSize} onFilter={onFilter} />
      <TopLegs report={report} top={top} />
      <Unpriced report={report} />
      <p className="muted small">{report.timing.summary}</p>
    </div>
  )
}
