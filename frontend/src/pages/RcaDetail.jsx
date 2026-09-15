import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  CalendarClock,
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  ExternalLink,
  FileText,
  History,
  MessageSquare,
  Paperclip,
  Plus,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Siren,
  Tag,
  UserCog,
  Users,
  Wrench,
  X,
} from 'lucide-react'
import clsx from 'clsx'

import {
  CATEGORY_LABELS,
  RcaStatusBadge,
  TIMELINE_SOURCE_LABELS,
  timelineTone,
} from '../components/rca'
import {
  Card,
  ConfirmDialog,
  DetailRow,
  ErrorState,
  Field,
  LoadingBlock,
  Modal,
  PageHeader,
  Spinner,
} from '../components/ui'
import LiveIndicator from '../components/LiveIndicator'
import { rcaApi, usersApi } from '../lib/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { copyToClipboard } from '../lib/clipboard'
import { formatDateTime, formatDuration } from '../lib/format'
import { useToast } from '../hooks/useToast'

/** Inline `code spans` inside an RCA body.
 *
 * RCA bodies are plain text, but a resolution is mostly commands and
 * identifiers: `kubectl delete node vm-...-prod-1` set in the same face as the
 * sentence around it is the difference between a step you can follow and a
 * wall of prose. Backticks are the only markup honoured, because they are
 * what people already type - nothing else is guessed at, so an RCA written
 * without them reads exactly as it was written.
 */
function RichText({ value }) {
  if (value === null || value === undefined) return null
  const parts = String(value).split(/(`[^`\n]+`)/g)
  return parts.map((part, index) =>
    part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
      <code
        key={index}
        className="mx-px rounded border border-slate-200 bg-slate-100 px-1 py-px font-mono text-[0.85em] text-slate-800 dark:border-navy-700 dark:bg-navy-800/80 dark:text-slate-200"
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  )
}

// The status, as the hero's edge. Mirrors the badge's own colours so the two
// never disagree; the badge carries the wording, this only reinforces it.
const STATUS_ACCENT = {
  completed: 'bg-emerald-500',
  in_progress: 'bg-blue-500',
  pending: 'bg-amber-500',
  not_required: 'bg-slate-300 dark:bg-slate-600',
  not_requested: 'bg-slate-300 dark:bg-slate-600',
}

/** One labelled fact in the hero's summary row. */
function Fact({ icon: Icon, label, children }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
        <Icon size={12} aria-hidden="true" />
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
        {children}
      </dd>
    </div>
  )
}

// Spelled out rather than composed from a tone name: Tailwind only keeps the
// class names it can see in the source, so `bg-${tone}-50` would ship as an
// unstyled tile.
const SECTION_TONE = {
  cause:
    'bg-rose-50 text-rose-600 ring-rose-200/70 dark:bg-rose-950/50 dark:text-rose-300 dark:ring-rose-900',
  impact:
    'bg-amber-50 text-amber-600 ring-amber-200/70 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900',
  fix:
    'bg-emerald-50 text-emerald-600 ring-emerald-200/70 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900',
  meta:
    'bg-slate-100 text-slate-500 ring-slate-200/70 dark:bg-navy-800 dark:text-slate-400 dark:ring-navy-700',
}

/** One section of a finished RCA, set as a document rather than a form.
 *
 * The marks are joined by a rail so the sections read as one report in a fixed
 * order - cause, impact, fix - which is the order the person on the next
 * incident wants them in. The measure is capped near 80 characters: a root
 * cause that runs the full width of a wide monitor is written once and read
 * never.
 */
function Section({ icon: Icon, tone, label, value, rail = true, children }) {
  return (
    <section className="relative pl-11">
      {rail ? (
        <span
          className="absolute bottom-[-1.5rem] left-[15px] top-9 w-px bg-slate-200 dark:bg-navy-800"
          aria-hidden="true"
        />
      ) : null}
      <span
        className={clsx(
          'absolute left-0 top-0 grid h-8 w-8 place-items-center rounded-lg ring-1',
          SECTION_TONE[tone] || SECTION_TONE.meta,
        )}
        aria-hidden="true"
      >
        <Icon size={16} />
      </span>
      <h3 className="pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400">
        {label}
      </h3>
      <div className="mt-1.5">
        {children ??
          (value ? (
            <p className="max-w-[80ch] whitespace-pre-wrap break-words text-[13.5px] leading-[1.65] text-slate-800 dark:text-slate-100">
              <RichText value={value} />
            </p>
          ) : (
            <p className="text-sm italic text-slate-400">Not recorded.</p>
          ))}
      </div>
    </section>
  )
}

export default function RcaDetail() {
  const { rcaId } = useParams()
  const toast = useToast()

  const [rca, setRca] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  const [form, setForm] = useState({
    root_cause: '',
    root_cause_category: '',
    impact: '',
    resolution: '',
  })
  const [actions, setActions] = useState([])
  const [newAction, setNewAction] = useState('')
  const [timeline, setTimeline] = useState([])
  const [attachments, setAttachments] = useState([])
  const [newAttachment, setNewAttachment] = useState({ label: '', url: '' })
  const [attachmentError, setAttachmentError] = useState(null)
  const [comment, setComment] = useState('')
  const [copied, setCopied] = useState(false)

  const [draftNotice, setDraftNotice] = useState(null)
  const [assignOpen, setAssignOpen] = useState(false)
  const [confirmComplete, setConfirmComplete] = useState(false)
  const [reopenOpen, setReopenOpen] = useState(false)
  const [reopen, setReopen] = useState({
    reason: '',
    // 'keep' leaves the current owner alone; the RCA usually goes back to
    // whoever closed it badly, but not always.
    owner_type: 'keep',
    owner_user_id: '',
    owner_team: '',
    due_in_days: '',
  })
  const [users, setUsers] = useState([])
  const [teams, setTeams] = useState([])
  const [assign, setAssign] = useState({
    owner_type: 'team',
    owner_user_id: '',
    owner_team: '',
    due_in_days: '',
  })

  const hydrate = useCallback((payload) => {
    setRca(payload)
    setForm({
      root_cause: payload.root_cause || '',
      root_cause_category: payload.root_cause_category || '',
      impact: payload.impact || '',
      resolution: payload.resolution || '',
    })
    setActions(payload.preventive_actions || [])
    setTimeline(payload.timeline || [])
    setAttachments(payload.attachments || [])
    setDirty(false)
  }, [])

  const load = useCallback(async () => {
    setError(null)
    try {
      hydrate(await rcaApi.get(rcaId))
    } catch (err) {
      setError(err.message)
    }
  }, [rcaId, hydrate])

  // `hydrate` replaces the form, so this must NEVER run over unsaved work.
  // Losing a half-written root cause to a background poll would be far worse
  // than not seeing a new comment for a minute, so `dirty` hard-stops it -
  // and the manual Refresh stays available for when the user is ready.
  const { refreshing, lastRefreshedAt } = useAutoRefresh(load, {
    paused: dirty || busy || assignOpen || confirmComplete || reopenOpen,
  })

  useEffect(() => {
    load()
    usersApi.list({ page: 1, page_size: 200 }).then((data) => {
      const rows = data.items || []
      setUsers(rows)
      setTeams([...new Set(rows.map((u) => u.team).filter(Boolean))].sort())
    }).catch(() => {})
    rcaApi.options().then((data) => {
      setTeams((current) => [...new Set([...current, ...(data.teams || [])])].sort())
    }).catch(() => {})
  }, [load])

  const set = (key) => (event) => {
    setForm((current) => ({ ...current, [key]: event.target.value }))
    setDirty(true)
  }

  const run = async (fn, message) => {
    setBusy(true)
    try {
      const result = await fn()
      if (message) toast.success(message)
      if (result?.id) hydrate(result)
      return result
    } catch (err) {
      toast.error(err.message)
      return null
    } finally {
      setBusy(false)
    }
  }

  const save = () =>
    run(
      () =>
        rcaApi.update(rca.id, {
          ...form,
          root_cause_category: form.root_cause_category || null,
          preventive_actions: actions,
          timeline,
          attachments,
        }),
      'RCA saved.',
    )

  // A finished RCA gets pasted into a ticket, a mail or a chat thread far more
  // often than it gets read here, and re-typing four sections by hand is how
  // they end up summarised into uselessness. Plain text, section order
  // preserved, so it survives wherever it lands.
  const report = useMemo(() => {
    if (!rca) return ''
    const lines = [
      `RCA-${rca.id} — ${rca.endpoint_name || 'Incident'}`,
      `Incident INC-${rca.incident_id}`,
      '',
      'ROOT CAUSE',
      form.root_cause || 'Not recorded.',
      '',
      'CATEGORY',
      CATEGORY_LABELS[form.root_cause_category] || 'Not categorised.',
      '',
      'IMPACT',
      form.impact || 'Not recorded.',
      '',
      'RESOLUTION',
      form.resolution || 'Not recorded.',
    ]
    if (actions.length) {
      lines.push('', 'PREVENTIVE ACTIONS')
      actions.forEach((action) => {
        lines.push(`${action.done ? '[x]' : '[ ]'} ${action.text}`)
      })
    }
    return lines.join('\n')
  }, [rca, form, actions])

  const doneCount = actions.filter((action) => action.done).length

  const copyReport = async () => {
    // copyToClipboard reports whether it ACTUALLY copied - on plain HTTP the
    // clipboard API is simply absent, and a checkmark over nothing is worse
    // than an error.
    if (await copyToClipboard(report)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      toast.error('Could not copy to the clipboard.')
    }
  }

  if (!rca && !error) {
    return (
      <>
        <PageHeader title="RCA" />
        <LoadingBlock rows={8} />
      </>
    )
  }
  if (error && !rca) {
    return (
      <>
        <PageHeader title="RCA" />
        <ErrorState message={error} onRetry={load} />
      </>
    )
  }

  const readOnly = !rca.can_edit

  return (
    <>
      <Link
        to="/rca"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
      >
        <ArrowLeft size={15} /> All RCAs
      </Link>

      <PageHeader
        title={`RCA-${rca.id} — ${rca.endpoint_name || 'Incident'}`}
        description={
          `Incident INC-${rca.incident_id}` +
          (rca.application ? ` · ${rca.application}` : '') +
          (rca.environment ? ` · ${rca.environment}` : '')
        }
        actions={
          <>
            <LiveIndicator
              refreshing={refreshing}
              lastRefreshedAt={lastRefreshedAt}
            />
            {rca.can_assign ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setAssign({
                    owner_type: rca.owner_type || 'team',
                    owner_user_id: '',
                    owner_team: rca.owner_team || '',
                    due_in_days: '',
                  })
                  setAssignOpen(true)
                }}
              >
                <UserCog size={15} /> Assign
              </button>
            ) : null}
            {rca.can_edit ? (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={async () => {
                    const draft = await run(() => rcaApi.draft(rca.id))
                    if (!draft) return
                    setForm({
                      root_cause: draft.root_cause || '',
                      root_cause_category: draft.root_cause_category || '',
                      impact: draft.impact || '',
                      resolution: draft.resolution || '',
                    })
                    setActions(draft.preventive_actions || [])
                    setTimeline(draft.timeline || [])
                    setDraftNotice(draft.notice)
                    setDirty(true)
                  }}
                >
                  {busy ? <Spinner size={15} /> : <FileText size={15} />}
                  Generate draft
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={save}
                  disabled={busy || !dirty}
                >
                  <Save size={15} /> Save
                </button>
              </>
            ) : null}
            {rca.can_complete ? (
              <button
                type="button"
                className="btn-primary"
                onClick={() => setConfirmComplete(true)}
                disabled={busy}
              >
                <CheckCircle2 size={15} /> Complete RCA
              </button>
            ) : null}
            {rca.can_reopen ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setReopen({
                    reason: '',
                    owner_type: 'keep',
                    owner_user_id: '',
                    owner_team: rca.owner_team || '',
                    due_in_days: '',
                  })
                  setReopenOpen(true)
                }}
                disabled={busy}
                title="Administrators only"
              >
                <RotateCcw size={15} /> Reopen
              </button>
            ) : null}
          </>
        }
      />

      {/* ------------------------------------------------------- hero */}
      <div className="card relative mb-4 overflow-hidden">
        {/* The status, carried as an edge the eye catches before it reads
            anything. The badge next to it is what actually states it - this
            is never the only signal. */}
        <span
          className={clsx(
            'absolute inset-y-0 left-0 w-1',
            rca.is_overdue
              ? 'bg-red-500'
              : STATUS_ACCENT[rca.status] || STATUS_ACCENT.not_requested,
          )}
          aria-hidden="true"
        />
        <div className="p-4 pl-5">
          <div className="flex flex-wrap items-center gap-2">
            <RcaStatusBadge status={rca.status} overdue={rca.is_overdue} />
            {form.root_cause_category ? (
              <span className="chip">
                <Tag size={11} />
                {CATEGORY_LABELS[form.root_cause_category] ||
                  form.root_cause_category}
              </span>
            ) : null}
          </div>

          <dl className="mt-3.5 grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            <Fact icon={UserCog} label="Owner">
              {rca.owner_label || (
                <span className="text-slate-400">Unassigned</span>
              )}
              {rca.owner_type ? (
                <span className="font-normal text-slate-400">
                  {' '}
                  · {rca.owner_type}
                </span>
              ) : null}
            </Fact>
            <Fact icon={CalendarClock} label="Due">
              {rca.due_at ? (
                <span className={clsx(rca.is_overdue && 'text-red-600 dark:text-red-400')}>
                  {formatDateTime(rca.due_at, 'dd MMM yyyy')}
                </span>
              ) : (
                // An RCA without a deadline is never overdue, which is worth
                // saying outright rather than leaving as an em dash.
                <span className="text-slate-400">No deadline</span>
              )}
            </Fact>
            <Fact icon={ShieldCheck} label="Signed off">
              {rca.completed_at ? (
                <>
                  {formatDateTime(rca.completed_at, 'dd MMM yyyy HH:mm')}
                  {rca.completed_by ? (
                    <span className="font-normal text-slate-400">
                      {' '}
                      by {rca.completed_by}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-slate-400">Not yet</span>
              )}
            </Fact>
            {/* Downtime, not the incident id - the id is in the page title
                and the Evidence card, and how long it was down is the fact a
                reader wants before any of the prose. */}
            <Fact icon={Siren} label="Downtime">
              {rca.incident?.duration_seconds ? (
                <>
                  {formatDuration(rca.incident.duration_seconds)}
                  <span className="font-normal text-slate-400">
                    {' '}
                    · {rca.incident.failed_check_count ?? 0} failed checks
                  </span>
                </>
              ) : rca.incident && !rca.incident.resolved_at ? (
                <span className="text-red-600 dark:text-red-400">Still open</span>
              ) : (
                <span className="text-slate-400">Not recorded</span>
              )}
            </Fact>
          </dl>

          {rca.incident ? (
            <p className="mt-3.5 border-t border-slate-100 pt-2.5 text-xs text-slate-500 dark:border-navy-800 dark:text-slate-400">
              RCA and incident lifecycles are independent — completing this
              changes nothing about the incident.
            </p>
          ) : null}
        </div>
      </div>

      {draftNotice ? (
        <div className="card mb-4 border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <span className="font-medium">Draft generated.</span> {draftNotice}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* --------------------------------------------------- form */}
        <div className="space-y-4 xl:col-span-2">
          <Card
            title="Root cause analysis"
            actions={
              readOnly ? (
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={copyReport}
                  title="Copy the whole report as text"
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? 'Copied' : 'Copy report'}
                </button>
              ) : null
            }
          >
            {readOnly ? (
              // Finished work is read, not edited. Scrolling a paragraph inside
              // a disabled textarea to find out what broke is the wrong shape
              // for the job, so a locked RCA renders as a document.
              <div className="space-y-6">
                <Section
                  icon={Search}
                  tone="cause"
                  label="Root cause"
                  value={form.root_cause}
                />
                {/* No Category section: it is a one-word label, and the hero
                    above already carries it as a chip where it can be scanned
                    with the status rather than read in sequence. */}
                <Section
                  icon={Users}
                  tone="impact"
                  label="Impact"
                  value={form.impact}
                />
                {/* Last section, so no rail below it - the document ends here. */}
                <Section
                  icon={Wrench}
                  tone="fix"
                  label="Resolution"
                  value={form.resolution}
                  rail={false}
                />
              </div>
            ) : (
              <div className="space-y-3">
                <Field
                  label="Root cause"
                  required
                  hint="What actually caused it. Required to complete."
                >
                  <textarea
                    className="input"
                    rows={5}
                    value={form.root_cause}
                    onChange={set('root_cause')}
                    placeholder="Describe what went wrong and why."
                  />
                </Field>

                <Field label="Category" hint="Optional — it is what makes reporting possible.">
                  <select
                    className="input"
                    value={form.root_cause_category}
                    onChange={set('root_cause_category')}
                  >
                    <option value="">Not categorised</option>
                    {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Impact">
                  <textarea
                    className="input"
                    rows={4}
                    value={form.impact}
                    onChange={set('impact')}
                    placeholder="Who and what was affected, and for how long."
                  />
                </Field>

                <Field
                  label="Resolution"
                  required
                  hint="What fixed it. Required to complete."
                >
                  <textarea
                    className="input"
                    rows={4}
                    value={form.resolution}
                    onChange={set('resolution')}
                    placeholder="What was done to restore service."
                  />
                </Field>
              </div>
            )}
          </Card>

          {/* ----------------------------------- preventive actions */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <ClipboardList size={15} /> Preventive actions
              </span>
            }
            actions={
              actions.length ? (
                // The count alone said nothing about whether any of them were
                // actually done, which is the only interesting thing about a
                // preventive-action list a month after the incident.
                <span className="flex items-center gap-2">
                  <span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200 dark:bg-navy-700">
                    <span
                      className="block h-full rounded-full bg-emerald-500 transition-all"
                      style={{ width: `${(doneCount / actions.length) * 100}%` }}
                    />
                  </span>
                  <span className="tnum text-xs text-slate-500 dark:text-slate-400">
                    {doneCount}/{actions.length} done
                  </span>
                </span>
              ) : null
            }
          >
            {actions.length === 0 ? (
              <p className="mb-3 text-sm text-slate-400">
                Nothing recorded yet. These are what stop the same incident
                happening a fourth time.
              </p>
            ) : (
              <ul className="mb-3 space-y-1">
                {actions.map((action, index) => (
                  // -mx-2 so the hover band reaches into the card's gutter
                  // while the text stays aligned with everything above it.
                  <li
                    key={index}
                    className="-mx-2 flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50 dark:hover:bg-navy-800/60"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 rounded"
                      checked={Boolean(action.done)}
                      disabled={readOnly}
                      onChange={() => {
                        setActions((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, done: !item.done } : item,
                          ),
                        )
                        setDirty(true)
                      }}
                    />
                    <span
                      className={clsx(
                        'min-w-0 flex-1 break-words text-sm leading-relaxed',
                        action.done
                          ? 'text-slate-400 line-through decoration-slate-300'
                          : 'text-slate-800 dark:text-slate-100',
                      )}
                    >
                      <RichText value={action.text} />
                    </span>
                    {/* Faint rather than hidden-until-hover: there is no hover
                        on a tablet, and a delete you cannot find is not a
                        tidier list. */}
                    {!readOnly ? (
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-slate-300 transition-colors hover:text-red-600 dark:text-slate-600 dark:hover:text-red-400"
                        aria-label={`Remove: ${action.text}`}
                        onClick={() => {
                          setActions((current) => current.filter((_, i) => i !== index))
                          setDirty(true)
                        }}
                      >
                        <X size={14} />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {!readOnly ? (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  const text = newAction.trim()
                  if (!text) return
                  setActions((current) => [...current, { text, done: false }])
                  setNewAction('')
                  setDirty(true)
                }}
              >
                <input
                  className="input flex-1"
                  placeholder="Add a preventive action…"
                  value={newAction}
                  onChange={(event) => setNewAction(event.target.value)}
                  maxLength={500}
                />
                <button type="submit" className="btn-secondary" disabled={!newAction.trim()}>
                  <Plus size={15} /> Add
                </button>
              </form>
            ) : null}
          </Card>

          {/* ----------------------------------------- attachments */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Paperclip size={15} /> Attachments ({attachments.length})
              </span>
            }
          >
            {attachments.length === 0 ? (
              <p className="mb-3 text-sm text-slate-400">
                No links yet. Point at wherever the actual document already
                lives - Drive, OneDrive, SharePoint, a wiki page.
              </p>
            ) : (
              <ul className="mb-3 space-y-1.5">
                {attachments.map((attachment, index) => (
                  <li
                    key={attachment.id || index}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 dark:border-navy-700"
                  >
                    <ExternalLink size={13} className="shrink-0 text-slate-400" />
                    <a
                      href={attachment.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 flex-1 truncate text-sm text-brand-600 hover:underline dark:text-brand-400"
                      title={attachment.url}
                    >
                      {attachment.label || attachment.url}
                    </a>
                    {attachment.added_by ? (
                      <span className="shrink-0 text-xs text-slate-400">
                        {attachment.added_by}
                      </span>
                    ) : null}
                    {!readOnly ? (
                      <button
                        type="button"
                        className="shrink-0 text-slate-400 hover:text-red-600"
                        aria-label={`Remove: ${attachment.label || attachment.url}`}
                        onClick={() => {
                          setAttachments((current) =>
                            current.filter((_, i) => i !== index),
                          )
                          setDirty(true)
                        }}
                      >
                        <X size={14} />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {!readOnly ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  const url = newAttachment.url.trim()
                  if (!url) return
                  if (!/^https?:\/\//i.test(url)) {
                    setAttachmentError('Link must start with http:// or https://')
                    return
                  }
                  setAttachments((current) => [
                    ...current,
                    { label: newAttachment.label.trim() || url, url },
                  ])
                  setNewAttachment({ label: '', url: '' })
                  setAttachmentError(null)
                  setDirty(true)
                }}
              >
                <div className="flex gap-2">
                  <input
                    className="input flex-1"
                    placeholder="Label (optional)"
                    value={newAttachment.label}
                    onChange={(event) => {
                      setNewAttachment((current) => ({ ...current, label: event.target.value }))
                      setAttachmentError(null)
                    }}
                    maxLength={200}
                  />
                  <input
                    className="input flex-[2]"
                    placeholder="https://drive.google.com/..."
                    value={newAttachment.url}
                    onChange={(event) => {
                      setNewAttachment((current) => ({ ...current, url: event.target.value }))
                      setAttachmentError(null)
                    }}
                    maxLength={2048}
                  />
                  <button
                    type="submit"
                    className="btn-secondary shrink-0"
                    disabled={!newAttachment.url.trim()}
                  >
                    <Plus size={15} /> Add
                  </button>
                </div>
                {attachmentError ? (
                  <p className="text-xs text-red-600 dark:text-red-400">{attachmentError}</p>
                ) : null}
              </form>
            ) : null}
          </Card>

          {/* ------------------------------------------- comments */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <MessageSquare size={15} /> Incident comments ({rca.comments.length})
              </span>
            }
          >
            {rca.comments.length === 0 ? (
              <p className="mb-3 text-sm text-slate-400">
                No comments on the incident. The conversation during an
                investigation is usually the best raw material for an RCA.
              </p>
            ) : (
              <ol className="mb-4 space-y-3">
                {rca.comments.map((entry) => (
                  <li key={entry.id} className="flex gap-2.5">
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-200 text-[11px] font-semibold uppercase text-slate-700 dark:bg-navy-700 dark:text-slate-200">
                      {(entry.username || '?').slice(0, 2)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs">
                        <span className="font-semibold text-slate-800 dark:text-slate-100">
                          {entry.username || 'unknown'}
                        </span>
                        <span className="ml-1.5 text-slate-400">
                          {formatDateTime(entry.created_at, 'dd MMM HH:mm')}
                        </span>
                      </p>
                      <p className="whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200">
                        {entry.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}

            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={async (event) => {
                event.preventDefault()
                if (!comment.trim()) return
                const created = await run(
                  () => rcaApi.addComment(rca.incident_id, comment.trim()),
                )
                if (created) {
                  setComment('')
                  load()
                }
              }}
            >
              <input
                className="input flex-1"
                placeholder="Add a comment to the incident…"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                maxLength={4000}
              />
              <button type="submit" className="btn-primary" disabled={busy || !comment.trim()}>
                Comment
              </button>
            </form>
          </Card>
        </div>

        {/* -------------------------------------------------- sidebar */}
        <div className="space-y-4">
          {/* evidence */}
          {rca.incident ? (
            <Card title="Evidence">
              <dl>
                <DetailRow label="Incident">
                  INC-{rca.incident.id} · {rca.incident.status}
                </DetailRow>
                <DetailRow label="Started">
                  {formatDateTime(rca.incident.started_at)}
                </DetailRow>
                <DetailRow label="Resolved">
                  {rca.incident.resolved_at
                    ? formatDateTime(rca.incident.resolved_at)
                    : null}
                </DetailRow>
                <DetailRow label="Duration">
                  {rca.incident.duration_seconds
                    ? `${Math.round(rca.incident.duration_seconds / 60)} minutes`
                    : null}
                </DetailRow>
                <DetailRow label="Reason">{rca.incident.reason}</DetailRow>
                <DetailRow label="Error">{rca.incident.error_message}</DetailRow>
                <DetailRow label="Failed checks">
                  {rca.incident.failed_check_count}
                </DetailRow>
                <DetailRow label="Endpoint">
                  {rca.incident.endpoint_id ? (
                    <Link
                      to={`/endpoints/${rca.incident.endpoint_id}`}
                      className="text-brand-600 hover:underline dark:text-brand-400"
                    >
                      {rca.endpoint_name}
                    </Link>
                  ) : (
                    rca.endpoint_name
                  )}
                </DetailRow>
                {rca.change_id ? (
                  <DetailRow label="Deployment">
                    <Link
                      to={`/changes/${rca.change_id}`}
                      className="text-brand-600 hover:underline dark:text-brand-400"
                    >
                      View the change
                    </Link>
                  </DetailRow>
                ) : null}
              </dl>
            </Card>
          ) : null}

          {/* timeline */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <History size={15} /> Timeline ({timeline.length})
              </span>
            }
          >
            {timeline.length === 0 ? (
              <p className="text-sm text-slate-400">
                Generate a draft to assemble a timeline from the monitoring,
                deployment and incident records.
              </p>
            ) : (
              // One continuous rail behind the dots rather than a rule under
              // each row: a sequence of events should look like a sequence.
              // Drawn with ::before rather than a span, because an <ol> may
              // only contain list items.
              <ol className="relative space-y-3.5 pl-5 before:absolute before:inset-y-1.5 before:left-[3px] before:w-px before:bg-slate-200 before:content-[''] dark:before:bg-navy-700">
                {timeline.map((entry, index) => (
                  <li key={index} className="relative">
                    <span
                      className={clsx(
                        'absolute -left-5 top-1.5 h-[7px] w-[7px] rounded-full ring-2 ring-white dark:ring-navy-900',
                        timelineTone(entry.kind),
                      )}
                      aria-hidden="true"
                    />
                    <p className="tnum text-[11px] text-slate-400">
                      {entry.at ? formatDateTime(entry.at, 'dd MMM HH:mm:ss') : '—'}
                      <span className="ml-1.5">
                        · {TIMELINE_SOURCE_LABELS[entry.source] || entry.source}
                      </span>
                    </p>
                    <p className="break-words text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                      <RichText value={entry.detail} />
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {/* similar past RCAs */}
          {rca.similar_past?.length ? (
            <Card
              title={
                <span className="flex items-center gap-1.5">
                  <ClipboardList size={15} /> Similar past incidents
                </span>
              }
            >
              <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                Historical context only. A similar incident before does not mean
                this one has the same cause.
              </p>
              <ul className="space-y-2.5">
                {rca.similar_past.map((item) => (
                  <li key={item.rca_id} className="border-b border-slate-100 pb-2 last:border-0 dark:border-navy-800">
                    <p className="text-xs text-slate-400">
                      <Link
                        to={`/rca/${item.rca_id}`}
                        className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                      >
                        RCA-{item.rca_id}
                      </Link>
                      {' · '}
                      {item.days_ago != null ? `${item.days_ago} days ago` : ''}
                      {item.same_endpoint ? ' · same endpoint' : ''}
                    </p>
                    <p className="text-sm text-slate-700 dark:text-slate-200">
                      {(item.root_cause || '').split('\n')[0]}
                    </p>
                    {item.resolution ? (
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Fixed by: {item.resolution.split('\n')[0]}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>

      {/* -------------------------------------------------- dialogs */}
      <Modal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title={`Assign RCA-${rca.id}`}
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setAssignOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={
                busy ||
                (assign.owner_type === 'team' && !assign.owner_team.trim()) ||
                (assign.owner_type === 'individual' && !assign.owner_user_id)
              }
              onClick={async () => {
                const result = await run(
                  () =>
                    rcaApi.assign(rca.id, {
                      owner_type: assign.owner_type,
                      owner_user_id: assign.owner_user_id || null,
                      owner_team: assign.owner_team || null,
                      due_in_days: assign.due_in_days
                        ? Number(assign.due_in_days)
                        : null,
                    }),
                  'RCA assigned.',
                )
                if (result) setAssignOpen(false)
              }}
            >
              Assign
            </button>
          </>
        }
      >
        <Field label="Owner type">
          <select
            className="input"
            value={assign.owner_type}
            onChange={(event) =>
              setAssign((current) => ({ ...current, owner_type: event.target.value }))
            }
          >
            <option value="team">Team</option>
            <option value="individual">Individual</option>
          </select>
        </Field>

        {assign.owner_type === 'team' ? (
          <Field label="Team" required hint="Anyone whose team label matches can edit this RCA.">
            <input
              className="input"
              value={assign.owner_team}
              onChange={(event) =>
                setAssign((current) => ({ ...current, owner_team: event.target.value }))
              }
              list="rca-teams"
              placeholder="DevOps"
              maxLength={64}
            />
            <datalist id="rca-teams">
              {teams.map((team) => (
                <option key={team} value={team} />
              ))}
            </datalist>
          </Field>
        ) : (
          <Field label="User" required>
            <select
              className="input"
              value={assign.owner_user_id}
              onChange={(event) =>
                setAssign((current) => ({
                  ...current,
                  owner_user_id: event.target.value,
                }))
              }
            >
              <option value="">Select a user…</option>
              {users.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.username}
                  {item.team ? ` (${item.team})` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Due in (days)" hint="Optional. Without one, an RCA is never overdue.">
          <input
            type="number"
            min={0}
            max={365}
            className="input"
            value={assign.due_in_days}
            onChange={(event) =>
              setAssign((current) => ({ ...current, due_in_days: event.target.value }))
            }
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={confirmComplete}
        onClose={() => setConfirmComplete(false)}
        busy={busy}
        title="Complete this RCA?"
        confirmLabel="Complete RCA"
        message="Confirm that the root cause and resolution are documented. This does not change the incident — the two lifecycles are independent."
        onConfirm={async () => {
          if (dirty) {
            const saved = await save()
            if (!saved) return
          }
          const result = await run(
            () => rcaApi.complete(rca.id), 'RCA completed.',
          )
          if (result) setConfirmComplete(false)
        }}
      />

      <Modal
        open={reopenOpen}
        onClose={() => setReopenOpen(false)}
        title={`Reopen RCA-${rca.id}?`}
        size="sm"
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setReopenOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={
                busy ||
                (reopen.owner_type === 'team' && !reopen.owner_team.trim()) ||
                (reopen.owner_type === 'individual' && !reopen.owner_user_id)
              }
              onClick={async () => {
                const reassigning = reopen.owner_type !== 'keep'
                const result = await run(
                  () =>
                    rcaApi.reopen(rca.id, {
                      reason: reopen.reason.trim() || null,
                      owner_type: reassigning ? reopen.owner_type : null,
                      owner_user_id: reopen.owner_user_id || null,
                      owner_team: reopen.owner_team || null,
                      due_in_days:
                        reassigning && reopen.due_in_days
                          ? Number(reopen.due_in_days)
                          : null,
                    }),
                  'RCA reopened.',
                )
                if (result) setReopenOpen(false)
              }}
            >
              {busy ? <Spinner size={15} /> : <RotateCcw size={15} />} Reopen
            </button>
          </>
        }
      >
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          This moves the RCA back to <strong>In progress</strong> so it can be
          edited and completed again. The previous sign-off is kept on the
          timeline, not erased.
        </p>

        <Field
          label="Reason"
          hint="Optional, but it goes on the timeline — the next reader will want to know what was wrong with the closed version."
        >
          <textarea
            className="input"
            rows={3}
            maxLength={500}
            value={reopen.reason}
            onChange={(event) =>
              setReopen((current) => ({ ...current, reason: event.target.value }))
            }
            placeholder="Root cause was wrong — the deployment at 14:02 was unrelated."
          />
        </Field>

        <Field
          label="Hand it to"
          hint="Reopening without an owner leaves it nobody's problem, which is usually how it got closed badly."
        >
          <select
            className="input"
            value={reopen.owner_type}
            onChange={(event) =>
              setReopen((current) => ({ ...current, owner_type: event.target.value }))
            }
          >
            <option value="keep">
              Keep the current owner{rca.owner_label ? ` (${rca.owner_label})` : ''}
            </option>
            <option value="team">A team</option>
            <option value="individual">An individual</option>
          </select>
        </Field>

        {reopen.owner_type === 'team' ? (
          <Field label="Team" required>
            <input
              className="input"
              value={reopen.owner_team}
              onChange={(event) =>
                setReopen((current) => ({ ...current, owner_team: event.target.value }))
              }
              list="rca-reopen-teams"
              placeholder="DevOps"
              maxLength={64}
            />
            {/* Its own list: the assign dialog's is unmounted while closed. */}
            <datalist id="rca-reopen-teams">
              {teams.map((team) => (
                <option key={team} value={team} />
              ))}
            </datalist>
          </Field>
        ) : null}

        {reopen.owner_type === 'individual' ? (
          <Field label="User" required>
            <select
              className="input"
              value={reopen.owner_user_id}
              onChange={(event) =>
                setReopen((current) => ({
                  ...current,
                  owner_user_id: event.target.value,
                }))
              }
            >
              <option value="">Select a user…</option>
              {users.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.username}
                  {item.team ? ` (${item.team})` : ''}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        {reopen.owner_type !== 'keep' ? (
          <Field label="Due in (days)" hint="Optional. Without one, an RCA is never overdue.">
            <input
              type="number"
              min={0}
              max={365}
              className="input"
              value={reopen.due_in_days}
              onChange={(event) =>
                setReopen((current) => ({
                  ...current,
                  due_in_days: event.target.value,
                }))
              }
            />
          </Field>
        ) : null}
      </Modal>
    </>
  )
}
