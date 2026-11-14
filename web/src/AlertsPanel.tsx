import { useId, useState } from 'react'
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

/** What came back from Check or Send test, for the topic it was about. */
interface Said {
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
        <label htmlFor={`${id}-edge`}>Edge</label>
        <span className="prefix">
          +
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
          <span className="muted">pts</span>
        </span>
      </div>
      <div className="field">
        <label htmlFor={`${id}-legs`}>Qualifying legs</label>
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

/**
 * Where auto runs' alerts go and when they're loud (GLOSSARY: Alert, Alert tier, Qualifying leg). Open while no topic
 * is set; folded away once one is, naming it. Changes save themselves, as the run settings do.
 */
export function AlertsPanel({ alerts }: { alerts: AlertSettings }) {
  const { form, saved, change, flush, unsaved, setToken, clearToken, saveError, loadError } = alerts
  const [open, setOpen] = useState<boolean | null>(null)
  const [checked, setChecked] = useState<Said | null>(null)
  const [tested, setTested] = useState<Said | null>(null)
  const [busy, setBusy] = useState<'check' | 'test' | null>(null)
  const [token, setTokenInput] = useState('')
  const id = useId()

  if (form && open === null) setOpen(!form.topic) // decided once, on opening: never folded away mid-edit

  const set = <K extends keyof AlertForm>(key: K, value: AlertForm[K]) => form && change({ ...form, [key]: value })

  const topic = form?.topic ?? ''
  const topicBad = topicProblem(topic)
  const usable = !!topic && !topicBad
  const serverBad = form ? serverProblem(form.server) : null
  const shown = (said: Said | null) => (said && said.topic === topic ? said : null)

  const random = () => {
    if (!form) return
    change({ ...form, topic: randomTopic() })
    void flush()
  }

  const check = async () => {
    setBusy('check')
    try {
      const { state, detail } = await checkTopic(topic)
      setChecked({ topic, text: `${CHECKED[state]}: ${detail}`, warn: state === 'recent' || state === 'reserved' })
    } catch (e) {
      setChecked({ topic, text: `Couldn't check: ${message(e)}`, warn: true })
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    setBusy('test')
    try {
      await flush() // the test goes to the saved topic: this one
      if (unsaved()?.topic !== undefined) throw new Error("the topic couldn't be saved")
      await sendTestAlert()
      setTested({ topic, text: `Test alert sent to ${topic}`, warn: false })
    } catch (e) {
      setTested({ topic, text: `Test alert not sent: ${message(e)}`, warn: true })
    } finally {
      setBusy(null)
    }
  }

  const saveToken = async () => {
    if (TOKEN.test(token) && (await setToken(token))) setTokenInput('')
  }

  const summary = !form
    ? null
    : form.topic && !topicBad
      ? `${form.topic} on ${host(saved?.server ?? form.server)}`
      : 'No topic: auto runs send no alerts'

  return (
    <section className="alerts" aria-labelledby={`${id}-h`}>
      <details open={!!open} onToggle={(e) => setOpen(e.currentTarget.open)}>
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
                <button type="button" className="secondary" disabled={!usable || busy !== null} onClick={check}>
                  Check
                </button>
                <button type="button" className="secondary" disabled={!usable || busy !== null} onClick={test}>
                  Send test
                </button>
              </div>
            </div>
            <div id={`${id}-topic-note`} className="topic-notes small">
              {topicBad ? (
                <p className="warn">{topicBad}</p>
              ) : (
                <p className="muted">
                  Anyone who knows a public topic's name can read and post to it; Random makes it hard to guess.
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
              {TIERS.map(({ name, label, priority }) => (
                <Tier key={name} name={name} label={label} priority={priority} tier={form[name]} onChange={(t) => set(name, t)} />
              ))}
              <p className="muted small">Neither met: priority 1 (silent). Unchanged legs repeat at priority 1.</p>
              {barsCrossed(form) && (
                <p className="warn small">Medium's edge bar is above high's: an alert meeting medium will usually meet high first.</p>
              )}
            </div>

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
    </section>
  )
}
