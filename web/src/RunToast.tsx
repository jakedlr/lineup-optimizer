import { useRef, type FocusEvent } from 'react'
import type { ShownNotice } from './useRunNotifier'

interface Props {
  notice: ShownNotice | null
  onClose: () => void
  /** The user is on the pop-up (pointer over it, or focus in it): its clock stops until they leave. */
  onHold: (held: boolean) => void
}

/**
 * The run notification pop-up. The live region is always on the page, so a screen reader hears each
 * notification as it is put in; only the toast inside it comes and goes. It waits while the pointer is on it or
 * focus is in it, and fades out as it goes.
 */
export function RunToast({ notice, onClose, onHold }: Props) {
  const on = useRef({ id: -1, pointer: false, focus: false }) // what holds the pop-up showing: a new one starts free
  const update = (key: 'pointer' | 'focus', value: boolean) => {
    if (on.current.id !== notice?.id) on.current = { id: notice?.id ?? -1, pointer: false, focus: false }
    on.current[key] = value
    onHold(on.current.pointer || on.current.focus)
  }
  const blur = (e: FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) update('focus', false)
  }

  return (
    <div className="toasts" role="status" aria-live="polite" aria-label="Run notifications">
      {notice && (
        <div
          key={notice.id}
          className="toast"
          data-kind={notice.kind}
          data-leaving={notice.leaving || undefined}
          onPointerEnter={() => update('pointer', true)}
          onPointerLeave={() => update('pointer', false)}
          onFocus={() => update('focus', true)}
          onBlur={blur}
        >
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
