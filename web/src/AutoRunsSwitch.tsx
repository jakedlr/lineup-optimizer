import type { AutoState } from './api'
import { clock } from './format'

interface Props {
  /** Null until the server has said. */
  auto: AutoState | null
  onToggle: () => void
}

/** Auto runs on or off (GLOSSARY: Auto run), and while on, when the next one starts. */
export function AutoRunsSwitch({ auto, onToggle }: Props) {
  const on = !!auto?.enabled
  return (
    <div className="auto-runs">
      <button type="button" role="switch" aria-checked={on} className="switch" disabled={!auto} onClick={onToggle}>
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        Auto runs
      </button>
      {on && auto?.next_run_at && <span className="muted small num">Next run {clock(auto.next_run_at)}</span>}
    </div>
  )
}
