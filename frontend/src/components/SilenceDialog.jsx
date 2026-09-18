import { useEffect, useState } from 'react'
import { BellOff } from 'lucide-react'

import { Field, Modal, Spinner } from './ui'

/* Windows people actually want, as one click each.
 *
 * Deliberately short by default: a silence is for a deployment or an
 * afternoon of known noise, and the one thing it must never become is the
 * reason nobody heard about an outage. 7 days is the API's ceiling. */
const DURATIONS = [
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '24 hours', minutes: 1440 },
  { label: '3 days', minutes: 4320 },
]

/* The same trick as the pause dialog: requiring a reason only works if giving
 * one is faster than resenting it. */
const COMMON_REASONS = [
  'Deploying',
  'Known issue, fix in progress',
  'Noisy — under investigation',
  'Waiting on the vendor',
  'Load testing',
]

/** When the silence will lift, said the way someone would say it. */
function endsAt(minutes) {
  const at = new Date(Date.now() + minutes * 60_000)
  const sameDay = at.toDateString() === new Date().toDateString()
  return at.toLocaleString(undefined, {
    weekday: sameDay ? undefined : 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Stop an endpoint's notifications for a while, without pausing it.
 *
 * The distinction is the whole point of the dialog, so it is stated at the
 * top: pausing stops the checks and loses the results, the incidents and the
 * uptime figure for the period, which is usually exactly the data wanted
 * afterwards. Silencing stops only the delivery.
 */
export default function SilenceDialog({
  open,
  onClose,
  onConfirm,
  busy = false,
  endpointName,
}) {
  const [minutes, setMinutes] = useState(60)
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (open) {
      setMinutes(60)
      setReason('')
    }
  }, [open])

  const trimmed = reason.trim()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={endpointName ? `Silence alerts for '${endpointName}'` : 'Silence alerts'}
      size="sm"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || trimmed.length < 3}
            onClick={() => onConfirm({ minutes, reason: trimmed })}
          >
            {busy ? <Spinner size={15} /> : <BellOff size={15} />} Silence
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
        Checks keep running and everything keeps being recorded — results,
        incidents and uptime. Only the notifications stop. Alerts still appear
        in the alert list, marked as not sent.
      </p>

      <Field label="For how long" required>
        <div className="flex flex-wrap gap-1.5">
          {DURATIONS.map((option) => (
            <button
              key={option.minutes}
              type="button"
              className={
                option.minutes === minutes
                  ? 'rounded-full border border-brand-500 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 dark:bg-navy-800 dark:text-brand-300'
                  : 'rounded-full border border-slate-300 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-brand-400 hover:text-brand-700 dark:border-navy-700 dark:text-slate-300 dark:hover:text-slate-100'
              }
              onClick={() => setMinutes(option.minutes)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Field>

      {/* The end time, not just the length. "4 hours" from a 17:00 deploy is
          21:00, and whether that is inside anyone's evening is the thing
          worth knowing before clicking. */}
      <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
        Alerts resume by themselves at <strong>{endsAt(minutes)}</strong>.
      </p>

      <div className="mt-3">
        <Field label="Reason" required hint="Shown wherever this appears as silenced.">
          <input
            className="input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={255}
            placeholder="Why is this being silenced?"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter' && trimmed.length >= 3 && !busy) {
                onConfirm({ minutes, reason: trimmed })
              }
            }}
          />
        </Field>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {COMMON_REASONS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="rounded-full border border-slate-300 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 dark:border-navy-700 dark:text-slate-300 dark:hover:bg-navy-800 dark:hover:text-slate-100"
              onClick={() => setReason(preset)}
            >
              {preset}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
