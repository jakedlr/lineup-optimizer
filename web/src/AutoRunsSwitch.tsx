import type { AutoState } from './api'
import { clock } from './format'

interface Props {
  /** Null until the server has said. */
  auto: AutoState | null
  onToggle: () => void
}

/**
 * Auto runs on or off (GLOSSARY: Auto run). Until the server has said which, the switch is aria-disabled at full
 * strength: it's waiting, not off-limits. It sits beside Run (in the Run bar, on a phone); when the next one starts is
 * `NextRun`, which stays in the page.
 */
export function AutoRunsSwitch({ auto, onToggle }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!auto?.enabled}
      aria-disabled={!auto || undefined}
      className="switch"
      onClick={() => auto && onToggle()}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      Auto runs
    </button>
  )
}

/** While auto runs are on, when the next one starts. */
export function NextRun({ auto }: { auto: AutoState | null }) {
  if (!auto?.enabled || !auto.next_run_at) return null
  return <span className="muted small num next-run">Next run {clock(auto.next_run_at)}</span>
}
