import { useEffect, useRef, useState } from 'react'
import type { Options } from './api'
import type { Settings } from './settings'
import { BLOCKED_NOTE, requestSystemNotify, systemNotifyState, UNSUPPORTED_NOTE } from './systemNotify'

interface Props {
  options: Options
  settings: Settings
  onChange: (next: Settings) => void
  noCache: boolean
  onNoCache: (v: boolean) => void
  /** Why the last change to the run settings didn't reach the server; they still apply on this page. */
  saveError?: string | null
}

const refLabel = (r: string) => `${r.startsWith('power') ? 'Power' : 'Flex'} ${r.slice(-1)}`

export function SettingsPanel({ options, settings, onChange, noCache, onNoCache, saveError }: Props) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value })

  const [notifyState, setNotifyState] = useState(systemNotifyState)
  const latest = useRef(settings) // the permission prompt answers later; don't undo edits made meanwhile
  useEffect(() => {
    latest.current = settings
  }, [settings])
  const notifyNote = notifyState === 'unsupported' ? UNSUPPORTED_NOTE : notifyState === 'denied' ? BLOCKED_NOTE : null

  const toggleNotify = (on: boolean) => {
    set('notify', on)
    if (!on || systemNotifyState() === 'granted') return
    // Asked inside the change handler: Firefox and Safari only prompt from a user gesture.
    requestSystemNotify().then((answer) => {
      setNotifyState(answer)
      if (answer !== 'granted') onChange({ ...latest.current, notify: false })
    })
  }

  const toggle = (sport: string) =>
    set(
      'sports',
      settings.sports.includes(sport)
        ? settings.sports.filter((s) => s !== sport)
        : options.sports.filter((s) => s === sport || settings.sports.includes(s)),
    )

  return (
    <section className="settings" aria-labelledby="settings-h">
      <div className="settings-head">
        <h2 id="settings-h" className="label">
          Run settings
        </h2>
        {saveError && <p className="warn small">{saveError}</p>}
      </div>
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
                  {d === 'worst' ? 'Worst case (lowest of four)' : d}
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
              Fresh odds <span className="muted small">(skip the 1-minute cache for this run)</span>
            </span>
          </label>
          <div className="check-field">
            <label className="check">
              <input
                type="checkbox"
                checked={settings.notify && !notifyNote}
                disabled={!!notifyNote}
                aria-describedby={notifyNote ? 'notify-note' : undefined}
                onChange={(e) => toggleNotify(e.target.checked)}
              />
              <span>Notify me when runs finish</span>
            </label>
            {notifyNote && (
              <p id="notify-note" className="muted small">
                {notifyNote}
              </p>
            )}
          </div>
        </div>
      </details>
    </section>
  )
}
