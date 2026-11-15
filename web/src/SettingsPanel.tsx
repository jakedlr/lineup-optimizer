import { useEffect, useId, useRef, useState } from 'react'
import type { Options } from './api'
import { dayClock } from './format'
import type { Problem, Settings } from './settings'
import { BLOCKED_NOTE, requestSystemNotify, systemNotifyState, UNSUPPORTED_NOTE } from './systemNotify'

interface Props {
  options: Options
  settings: Settings
  onChange: (next: Settings) => void
  /** Why the last change to the run settings didn't reach the server; they still apply on this page. */
  saveError?: string | null
  /** When the server last saved the run settings (null: never). */
  savedAt?: string | null
  /** Why a run can't go, when it's one of these settings: said under it. */
  problem?: Problem | null
}

/** A chip that is on: a check, so "on" isn't told by its fill alone. */
function Check() {
  return (
    <svg className="check" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="m1.5 5.5 2.25 2.25L8.5 2.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const refLabel = (r: string) => `${r.startsWith('power') ? 'Power' : 'Flex'} ${r.slice(-1)}`

export function SettingsPanel({ options, settings, onChange, saveError, savedAt, problem }: Props) {
  const id = useId()
  const why = (field: Problem['field']) => (problem?.field === field ? problem.text : null)
  /** The props that tie a field to the reason it holds the run, said under it. */
  const fault = (field: Problem['field']) => ({
    'aria-invalid': !!why(field),
    'aria-describedby': why(field) ? `${id}-${field}` : undefined,
  })
  const note = (field: Problem['field']) =>
    why(field) && (
      <p id={`${id}-${field}`} className="warn small">
        {why(field)}
      </p>
    )
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
        {saveError ? (
          <p className="warn small">{saveError}</p>
        ) : (
          <p className="muted small">{savedAt ? `Saved ${dayClock(savedAt)} · auto runs use these too` : 'Auto runs use these too'}</p>
        )}
      </div>
      <div className="settings-row">
        <div className="leagues">
          <span id="leagues-label">Leagues</span>
          <div className="chips" role="group" aria-labelledby="leagues-label" aria-describedby={fault('sports')['aria-describedby']}>
            {options.sports.map((s) => (
              <button
                key={s}
                type="button"
                className="chip"
                aria-pressed={settings.sports.includes(s)}
                onClick={() => toggle(s)}
              >
                {settings.sports.includes(s) && <Check />}
                {s}
              </button>
            ))}
          </div>
          {note('sports')}
        </div>

        <div className="field stake">
          <label htmlFor={`${id}-stake-input`}>Stake</label>
          <span className="prefix">
            $
            <input
              id={`${id}-stake-input`}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={settings.stake}
              {...fault('stake')}
              onChange={(e) => set('stake', e.target.value)}
            />
          </span>
          {note('stake')}
        </div>
      </div>

      <details className="advanced">
        <summary>Advanced</summary>
        <div className="grid">
          <div className="field">
            <label htmlFor={`${id}-hours-input`}>Hours ahead</label>
            <input
              id={`${id}-hours-input`}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={settings.hours}
              {...fault('hours')}
              onChange={(e) => set('hours', e.target.value)}
            />
            {note('hours')}
          </div>
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

/** The Run settings card while its settings load: the title at once, and a flat bar where each control will be. */
export function SettingsPlaceholder() {
  return (
    <section className="settings" aria-labelledby="settings-ph-h" aria-busy="true">
      <div className="settings-head">
        <h2 id="settings-ph-h" className="label">
          Run settings
        </h2>
      </div>
      <div className="settings-row" aria-hidden="true">
        <div className="leagues">
          <span>Leagues</span>
          <div className="chips">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="ph ph-chip" />
            ))}
          </div>
        </div>
        <div className="field stake">
          <span>Stake</span>
          <span className="ph ph-input" />
        </div>
      </div>
      <span className="ph ph-line" aria-hidden="true" />
    </section>
  )
}
