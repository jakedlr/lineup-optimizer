import type { Leg, Report } from './api'
import { bookAbbr, pct, pick, signedDollars, signedPct } from './format'

const TOP_LEGS = 25

function LegLine({ leg }: { leg: Leg }) {
  return (
    <li className="slip-leg">
      <span className="num">{pct(leg.prob)}</span>
      <span className="tag">{leg.sport}</span>
      <span className="muted matchup">{leg.matchup}</span>
      <span className="who">
        {leg.player} <span className="muted">· {pick(leg)}</span>
        {leg.promo_type && <span className="badge">{leg.promo_type}</span>}
      </span>
    </li>
  )
}

function BestSlips({ report }: { report: Report }) {
  return (
    <section aria-labelledby="slips-h" className="block">
      <h2 id="slips-h">Best Slips</h2>
      <p className="muted small">One leg per game, ${report.settings.stake} stake.</p>
      {report.slips.length === 0 ? (
        <p className="muted">None: not enough distinct games.</p>
      ) : (
        <div className="slips">
          {report.slips.map((s) => (
            <article key={`${s.type}${s.size}`} className="slip">
              <header>
                <h3>
                  {s.type === 'power' ? 'Power' : 'Flex'} {s.size}
                </h3>
                <span className={s.ev >= 0 ? 'pos num' : 'neg num'}>{signedDollars(s.ev)}</span>
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

function TopLegs({ report }: { report: Report }) {
  const legs = report.legs.slice(0, TOP_LEGS)
  const ref = report.ref_slip
  return (
    <section aria-labelledby="legs-h" className="block">
      <h2 id="legs-h">Top Legs</h2>
      <p className="muted small">
        {legs.length} of {report.legs.length}. Edge is against the {ref.type} {ref.size} break-even of {pct(ref.break_even)} per leg.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="num">Prob</th>
              <th className="num">Edge</th>
              <th>Sport</th>
              <th>Matchup</th>
              <th>Player</th>
              <th>Pick</th>
              <th>Books</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((l) => {
              const notes = [
                l.promo_type && `${l.promo_type}${l.modelled ? ' (modelled)' : ''}`,
                l.same_game && 'same game',
                l.disagreement >= 0.03 && `books differ ${(l.disagreement * 100).toFixed(1)} pts`,
              ].filter(Boolean)
              return (
                <tr key={`${l.game}|${l.player}|${l.stat}|${l.side}|${l.line}`}>
                  <td className="num">{pct(l.prob)}</td>
                  <td className={`num ${(l.edge ?? 0) >= 0 ? 'pos' : 'neg'}`}>{signedPct(l.edge ?? 0)}</td>
                  <td>{l.sport}</td>
                  <td className="nowrap">{l.matchup}</td>
                  <td className="nowrap">{l.player}</td>
                  <td>{pick(l)}</td>
                  <td className="nowrap muted small">
                    {Object.entries(l.books)
                      .sort()
                      .map(([b, p]) => `${bookAbbr(b)} ${(p * 100).toFixed(1)}`)
                      .join('  ')}
                  </td>
                  <td className="muted small">{notes.join(', ')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
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
              <table>
                <tbody>
                  {report.unmatched_lines.map((u, i) => (
                    <tr key={i}>
                      <td>{u.sport}</td>
                      <td className="nowrap">{u.player}</td>
                      <td>{u.stat}</td>
                      <td className="num">{u.line}</td>
                      <td className="muted small">{u.reason}</td>
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

export function ReportView({ report }: { report: Report }) {
  const s = report.settings
  return (
    <div className="report">
      <p className="muted small">
        ${s.stake} stake · {s.mode} · devig {s.devig} · {s.sports.join(', ')} · next {s.hours} h
      </p>
      {report.warnings.length > 0 && (
        <ul className="warnings">
          {report.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <BestSlips report={report} />
      <TopLegs report={report} />
      <Unpriced report={report} />
    </div>
  )
}
