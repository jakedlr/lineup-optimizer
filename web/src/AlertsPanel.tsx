import { useId, useMemo, useState } from 'react'
import { checkTopic, message, sendTestAlert, type TierName, type TopicState } from './api'
import {
  barsCrossed,
  edgeProblem,
  legsProblem,
  randomTopic,
  serverProblem,
  subscribeUrl,
  tierSummary,
  TIERS,
  topicProblem,
  zoneChoices,
  zoneValue,
  type AlertForm,
  type TierForm,
} from './alertForm'
import type { AlertSettings } from './useAlertSettings'

const TOKEN = /^[\x21-\x7e]{1,256}$/

const CHECKED: Record<TopicState, string> = {
  unused: 'Looks unused',
  recent: 'In use',
  reserved: 'Reserved',
  unknown: "Couldn't tell",
}

/** What came back from Check or Send test, for the server and topic it was about. */
interface Said {
  server: string
  topic: string
  text: string
  warn: boolean
}

const host = (server: string) => {
  try {
    return new URL(server).host
  } catch {
    return server
  }
}

function Tier({ name, label, priority, tier, onChange }: { name: TierName; label: string; priority: number; tier: TierForm; onChange: (t: TierForm) => void }) {
  const id = useId()
  const problem = edgeProblem(tier.edge) ?? legsProblem(tier.legs)
  return (
    <div className="tier" role="group" aria-label={`${label} tier`} data-tier={name}>
      <button type="button" role="switch" aria-checked={tier.enabled} className="switch" onClick={() => onChange({ ...tier, enabled: !tier.enabled })}>
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        <span className="tier-name">{label}</span>
        <span className="muted small">priority {priority}</span>
      </button>
      <div className="field">
        <label htmlFor={`${id}-edge`} className="tier-label">
          Edge
        </label>
        <span className="suffix">
          <input
            id={`${id}-edge`}
            type="number"
            inputMode="decimal"
            min="0.1"
            max="20"
            step="0.1"
            value={tier.edge}
            aria-invalid={!!edgeProblem(tier.edge)}
            aria-describedby={`${id}-says`}
            onChange={(e) => onChange({ ...tier, edge: e.target.value })}
          />
          <span className="muted">%</span>
        </span>
      </div>
      <div className="field">
        <label htmlFor={`${id}-legs`} className="tier-label">
          Qualifying legs
        </label>
        <input
          id={`${id}-legs`}
          type="number"
          inputMode="numeric"
          min="1"
          max="6"
          step="1"
          value={tier.legs}
          aria-invalid={!!legsProblem(tier.legs)}
          aria-describedby={`${id}-says`}
          onChange={(e) => onChange({ ...tier, legs: e.target.value })}
        />
      </div>
      <p id={`${id}-says`} className={`tier-says ${problem ? 'warn' : 'muted'}`}>
        {problem ?? tierSummary(tier)}
      </p>
    </div>
  )
}

const OPEN_KEY = 'ppopt.alertsOpen'

/** Whether this browser left the panel open: folded unless it says so. */
function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function saveOpen(open: boolean) {
  try {
    if (open) localStorage.setItem(OPEN_KEY, '1')
    else localStorage.removeItem(OPEN_KEY)
  } catch {
    // not remembered; still applied
  }
}

/** This browser's time zone, listed first. */
const here = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The zone alert titles' clock is in: chosen from the zones this browser lists, or typed where it lists none. */
function ZoneField({ id, value, onChange }: { id: string; value: string; onChange: (zone: string) => void }) {
  const zones = useMemo(() => zoneChoices(value, here()), [value])
  const bad = value && !zoneValue(value) ? 'Not a time zone this browser knows, e.g. America/New_York.' : null
  return (
    <div className="field zone-field">
      <label htmlFor={id}>Alert times in</label>
      {zones.length ? (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {!value && <option value="">UTC (none chosen)</option>}
          {zones.map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="UTC"
          value={value}
          aria-invalid={!!bad}
          aria-describedby={bad ? `${id}-note` : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {bad && (
        <p id={`${id}-note`} className="warn small">
          {bad}
        </p>
      )}
    </div>
  )
}

/**
 * Where auto runs' alerts go and when they're loud (GLOSSARY: Alert, Alert tier, Qualifying leg). Folded to one line
 * naming where alerts go (with a Set up button while there's no topic), open or folded as this browser last left it.
 * Changes save themselves, as the run settings do.
 */
export function AlertsPanel({ alerts }: { alerts: AlertSettings }) {
  const { form, saved, change, flush, unsaved, setToken, clearToken, saveError, loadError } = alerts
  const [open, setOpenState] = useState(loadOpen)
  const [checked, setChecked] = useState<Said | null>(null)
  const [tested, setTested] = useState<Said | null>(null)
  const [busy, setBusy] = useState<'check' | 'test' | null>(null)
  const [token, setTokenInput] = useState('')
  const id = useId()

  const setOpen = (next: boolean) => {
    setOpenState(next)
    saveOpen(next)
  }

  const set = <K extends keyof AlertForm>(key: K, value: AlertForm[K]) => form && change({ ...form, [key]: value })

  const topic = form?.topic ?? ''
  const topicBad = topicProblem(topic)
  const usable = !!topic && !topicBad
  const server = form?.server ?? ''
  const serverBad = form ? serverProblem(server) : null
  const ready = usable && !serverBad // Check and Send test go through the saved server
  // Why Check and Send test can't go, when nothing else on the panel says so.
  const why = !topic ? 'Set a topic to check or test it.' : !topicBad && serverBad ? 'Fix the server under Server and token first.' : null
  const shown = (said: Said | null) => (said && said.topic === topic && said.server === server ? said : null)

  const random = () => {
    if (!form) return
    change({ ...form, topic: randomTopic() })
    void flush()
  }

  /** Save what's waiting, so the server goes by what's shown here: the server and token it holds, and the topic. */
  const saveFirst = async (fields: ('server' | 'topic')[]) => {
    await flush()
    const left = unsaved()
    const lost = fields.find((f) => left?.[f] !== undefined)
    if (lost) throw new Error(`the ${lost} couldn't be saved`)
  }

  const check = async () => {
    if (busy) return
    setBusy('check')
    const about = { server, topic }
    try {
      await saveFirst(['server']) // the topic as typed is asked about, on the saved server
      const { state, detail } = await checkTopic(topic)
      setChecked({ ...about, text: `${CHECKED[state]}: ${detail}`, warn: state === 'recent' || state === 'reserved' })
    } catch (e) {
      setChecked({ ...about, text: `Couldn't check: ${message(e)}`, warn: true })
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    if (busy) return
    setBusy('test')
    const about = { server, topic }
    try {
      await saveFirst(['topic', 'server']) // the test goes to the saved topic on the saved server: these
      await sendTestAlert()
      setTested({ ...about, text: `Test alert sent to ${topic}`, warn: false })
    } catch (e) {
      setTested({ ...about, text: `Test alert not sent: ${message(e)}`, warn: true })
    } finally {
      setBusy(null)
    }
  }

  const saveToken = async () => {
    if (TOKEN.test(token) && (await setToken(token))) setTokenInput('')
  }

  // Where auto runs' alerts go now: what the server holds, not what's being typed.
  const summary = !saved
    ? null
    : saved.topic
      ? `${saved.topic} on ${host(saved.server)}`
      : 'No topic: auto runs send no alerts'
  const setUp = !open && !!saved && !saved.topic

  return (
    <section className="alerts" aria-labelledby={`${id}-h`} data-set-up={setUp || undefined}>
      <details open={open} onToggle={(e) => e.currentTarget.open !== open && setOpen(e.currentTarget.open)}>
        <summary>
          <h2 id={`${id}-h`} className="label">
            Phone alerts
          </h2>
          {summary && <span className="muted small alerts-summary">{summary}</span>}
        </summary>
        {loadError && <p className="warn small">{loadError}</p>}
        {form && (
          <div className="alerts-body">
            {saveError && <p className="warn small">{saveError}</p>}
            <div className="topic">
              <div className="field topic-field">
                <label htmlFor={`${id}-topic`}>Topic</label>
                <input
                  id={`${id}-topic`}
                  type="text"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  maxLength={64}
                  value={topic}
                  aria-invalid={!!topicBad}
                  aria-describedby={`${id}-topic-note`}
                  onChange={(e) => set('topic', e.target.value)}
                />
              </div>
              <div className="topic-actions">
                <button type="button" className="secondary" onClick={random}>
                  Random
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!ready}
                  aria-busy={busy === 'check' || undefined}
                  aria-describedby={why ? `${id}-why` : undefined}
                  onClick={check}
                >
                  {busy === 'check' ? 'Checking…' : 'Check'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!ready}
                  aria-busy={busy === 'test' || undefined}
                  aria-describedby={why ? `${id}-why` : undefined}
                  onClick={test}
                >
                  {busy === 'test' ? 'Sending…' : 'Send test'}
                </button>
                {why && (
                  <span id={`${id}-why`} className="muted small">
                    {why}
                  </span>
                )}
              </div>
            </div>
            <div id={`${id}-topic-note`} className="topic-notes small">
              {topicBad ? (
                <p className="warn">{topicBad}</p>
              ) : (
                <p className="muted">
                  Anyone with a public topic's name can read it and post to it; Random makes one hard to guess.
                  {usable && !serverBad && (
                    <>
                      {' '}
                      Subscribe at{' '}
                      <a href={subscribeUrl(form.server, topic)} target="_blank" rel="noreferrer">
                        {subscribeUrl(form.server, topic).replace(/^https?:\/\//, '')}
                      </a>
                      .
                    </>
                  )}
                </p>
              )}
              {shown(checked) && <p className={shown(checked)!.warn ? 'warn' : 'muted'}>{shown(checked)!.text}</p>}
              {shown(tested) && <p className={shown(tested)!.warn ? 'warn' : 'muted'}>{shown(tested)!.text}</p>}
            </div>

            <div className="tiers">
              <div className="tier-head" aria-hidden="true">
                <span />
                <span>Edge</span>
                <span>Qualifying legs</span>
              </div>
              {TIERS.map(({ name, label, priority }) => (
                <Tier key={name} name={name} label={label} priority={priority} tier={form[name]} onChange={(t) => set(name, t)} />
              ))}
              {barsCrossed(form) && (
                <p className="warn small">Medium's edge bar is above high's: an alert meeting medium will usually meet high first.</p>
              )}
              <details className="tier-more">
                <summary>When neither is met</summary>
                <p className="muted small">Neither met: priority 1 (silent). Unchanged legs repeat at priority 1.</p>
              </details>
            </div>

            {/* Only while open: listing some 400 zones by name and offset is work a folded panel needn't do. */}
            {open && <ZoneField id={`${id}-zone`} value={form.timezone} onChange={(v) => set('timezone', v)} />}

            <details className="advanced">
              <summary>Server and token</summary>
              <div className="grid">
                <div className="field">
                  <label htmlFor={`${id}-server`}>Server</label>
                  <input
                    id={`${id}-server`}
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    value={form.server}
                    aria-invalid={!!serverBad}
                    aria-describedby={serverBad ? `${id}-server-note` : undefined}
                    onChange={(e) => set('server', e.target.value)}
                  />
                  {serverBad && (
                    <p id={`${id}-server-note`} className="warn small">
                      {serverBad}
                    </p>
                  )}
                </div>
                {saved?.token_set ? (
                  <div className="field">
                    <span>Access token</span>
                    <span className="token-set">
                      Token set
                      <button type="button" className="secondary small" aria-label="Clear token" onClick={() => void clearToken()}>
                        Clear
                      </button>
                    </span>
                  </div>
                ) : (
                  <form
                    className="field"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void saveToken()
                    }}
                  >
                    <label htmlFor={`${id}-token`}>Access token</label>
                    <span className="joined">
                      <input
                        id={`${id}-token`}
                        type="password"
                        autoComplete="off"
                        value={token}
                        onChange={(e) => setTokenInput(e.target.value)}
                      />
                      <button type="submit" className="secondary" disabled={!TOKEN.test(token)}>
                        Save token
                      </button>
                    </span>
                  </form>
                )}
              </div>
            </details>
          </div>
        )}
      </details>
      {setUp && (
        <button type="button" className="secondary small set-up" onClick={() => setOpen(true)}>
          Set up
        </button>
      )}
    </section>
  )
}
