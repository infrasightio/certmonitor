import { useEffect, useState } from 'react'
import { Pause } from 'lucide-react'

import { Field, Modal, Spinner } from './ui'

/* The reasons people actually give, offered as one click each.
 *
 * Requiring a reason only works if giving one is faster than resenting it -
 * a free-text box alone gets "test" typed into it by the third pause. */
const COMMON_REASONS = [
  'Planned maintenance',
  'Known issue, fix in progress',
  'Endpoint decommissioned',
  'Noisy — under investigation',
  'Waiting on the vendor',
]

/**
 * Ask why monitoring is being paused, before it goes quiet.
 *
 * A paused endpoint reports nothing: no checks, no incidents, no alerts. Six
 * weeks later, an endpoint sitting at Paused with no reason is indistinguishable
 * from an outage nobody noticed, and the honest answer to "why is this off?"
 * becomes "nobody remembers". The reason is shown on the endpoints table, the
 * detail page and the paused-endpoints report.
 */
export default function PauseDialog({
  open,
  onClose,
  onConfirm,
  busy = false,
  title = 'Pause monitoring',
  description,
}) {
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (open) setReason('')
  }, [open])

  const trimmed = reason.trim()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !trimmed}
            onClick={() => onConfirm(trimmed)}
          >
            {busy ? <Spinner size={15} /> : <Pause size={15} />} Pause
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
        {description ||
          'No checks run while paused — no results, no incidents, no alerts, and the time does not count against uptime.'}
      </p>

      <Field label="Reason" required hint="Shown wherever this appears as paused.">
        <input
          className="input"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={255}
          placeholder="Why is this being paused?"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Enter' && trimmed && !busy) onConfirm(trimmed)
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
    </Modal>
  )
}
