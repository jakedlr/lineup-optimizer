import type { Leg, Report } from './api'
import { bookAbbr, pct, pick, runTiming, signedDollars, signedPct, slipName } from './format'
import { Segmented } from './Segmented'
import type { Settings } from './settings'

type SlipFilter = Pick<Settings, 'slipType' | 'slipSize'>

interface Props extends SlipFilter {
  report: Report
  top: number
  onFilter: (f: Partial<SlipFilter>) => void
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

function BestSlips({ report, slipType, slipSize, onFilter }: Omit<Props, 'top'>) {
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
      <p className="muted small">One leg per game, ${report.settings.stake} stake.</p>
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

function TopLegs({ report, top }: { report: Report; top: number }) {
  const legs = report.legs.slice(0, top)
  const ref = report.ref_slip
  return (
    <section aria-labelledby="legs-h" className="block">
      <h2 id="legs-h">Top Legs</h2>
      <p className="muted small">
        {legs.length} of {report.legs.length}. Edge is against the {ref.type} {ref.size} break-even of {pct(ref.break_even)} per leg.
      </p>
      <div className="table-wrap">
        <table className="legs-table">
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
                  <td className="num c-prob">{pct(l.prob)}</td>
                  <td className={`num c-edge ${(l.edge ?? 0) >= 0 ? 'pos' : 'neg'}`}>{signedPct(l.edge ?? 0)}</td>
                  <td className="c-sport">{l.sport}</td>
                  <td className="nowrap c-matchup">{l.matchup}</td>
                  <td className="nowrap c-player">{l.player}</td>
                  <td className="c-pick">{pick(l)}</td>
                  <td className="nowrap muted small c-books">
                    {Object.entries(l.books)
                      .sort()
                      .map(([b, p]) => `${bookAbbr(b)} ${(p * 100).toFixed(1)}`)
                      .join('  ')}
                  </td>
                  <td className="muted small c-notes">{notes.join(', ')}</td>
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

export function ReportView({ report, top, slipType, slipSize, onFilter }: Props) {
  const s = report.settings
  return (
    <div className="report">
      <div className="report-head">
        <p className="muted small">
          ${s.stake} stake · {s.mode} · devig {s.devig} · {s.sports.join(', ')} · next {s.hours} h
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
      <p className="muted small">{runTiming(report.timing)}</p>
    </div>
  )
}
