import type { Options } from './api'
import type { Settings } from './settings'

interface Props {
  options: Options
  settings: Settings
  onChange: (next: Settings) => void
  noCache: boolean
  onNoCache: (v: boolean) => void
}

const refLabel = (r: string) => `${r.startsWith('power') ? 'Power' : 'Flex'} ${r.slice(-1)}`

export function SettingsPanel({ options, settings, onChange, noCache, onNoCache }: Props) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value })

  const toggle = (sport: string) =>
    set(
      'sports',
      settings.sports.includes(sport)
        ? settings.sports.filter((s) => s !== sport)
        : options.sports.filter((s) => s === sport || settings.sports.includes(s)),
    )

  return (
    <section className="settings" aria-labelledby="settings-h">
      <h2 id="settings-h" className="label">
        Run settings
      </h2>
      <div className="settings-row">
        <div className="leagues">
          <span id="leagues-label">Leagues</span>
          <div className="chips" role="group" aria-labelledby="leagues-label">
            {options.sports.map((s) => (
              <button
                key={s}
                type="button"
                className="chip"
                aria-pressed={settings.sports.includes(s)}
                onClick={() => toggle(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <label className="field stake">
          <span>Stake</span>
          <span className="prefix">
            $
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={settings.stake}
              onChange={(e) => set('stake', e.target.value)}
            />
          </span>
        </label>
      </div>

      <details className="advanced">
        <summary>Advanced</summary>
        <div className="grid">
          <label className="field">
            <span>Hours ahead</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={settings.hours}
              onChange={(e) => set('hours', e.target.value)}
            />
          </label>
          <label className="field">
            <span>Devig method</span>
            <select value={settings.devig} onChange={(e) => set('devig', e.target.value)}>
              {options.devig.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Edge against</span>
            <select value={settings.refSlip} onChange={(e) => set('refSlip', e.target.value)}>
              <option value="">Lowest break-even (auto)</option>
              {options.ref_slips.map((r) => (
                <option key={r} value={r}>
                  {refLabel(r)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Legs to show</span>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={settings.top}
              onChange={(e) => set('top', e.target.value)}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={noCache} onChange={(e) => onNoCache(e.target.checked)} />
            <span>
              Fresh odds <span className="muted small">(skip the 5-minute cache for this run)</span>
            </span>
          </label>
        </div>
      </details>
    </section>
  )
}
