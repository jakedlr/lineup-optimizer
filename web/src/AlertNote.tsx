import type { AlertOutcome } from './api'

/** How a run's alert went, beside its mark: "Alert sent · priority 4", or a warning saying why it didn't arrive. */
export function AlertNote({ alert }: { alert: AlertOutcome }) {
  return alert.sent ? (
    <span className="alert-sent">Alert sent{alert.priority !== null && ` · priority ${alert.priority}`}</span>
  ) : (
    <span className="warn alert-failed">Alert not delivered: {alert.error ?? 'no reason given'}</span>
  )
}
