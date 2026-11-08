import type { ShownNotice } from './useRunNotifier'

/**
 * The run notification pop-up. The live region is always on the page, so a screen reader hears each
 * notification as it is put in; only the toast inside it comes and goes.
 */
export function RunToast({ notice, onClose }: { notice: ShownNotice | null; onClose: () => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite" aria-label="Run notifications">
      {notice && (
        <div key={notice.id} className="toast" data-kind={notice.kind}>
          <div className="toast-text">
            <p className="toast-title">{notice.title}</p>
            <p className="toast-body">{notice.body}</p>
          </div>
          <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="m3.5 3.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
