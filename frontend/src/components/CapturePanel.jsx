import { useEffect, useRef, useState } from 'react'
import { Camera, Check, Copy, Download, FileText, ImageOff } from 'lucide-react'
import clsx from 'clsx'

import { Card, EmptyState, LoadingBlock, StatusBadge } from './ui'
import { endpointsApi, saveBlob } from '../lib/api'
import { copyToClipboard } from '../lib/clipboard'
import { formatBytes, formatDateTime, formatMs, formatRelative } from '../lib/format'
import { useToast } from '../hooks/useToast'

const OUTCOME_LABEL = {
  success: 'Last successful response',
  failure: 'Last failed response',
}

// The edge colour only; the heading says which is which in words.
const OUTCOME_ACCENT = {
  success: 'bg-green-500',
  failure: 'bg-red-500',
}

/**
 * The screenshot for one capture.
 *
 * Fetched as a blob rather than pointed at with `<img src>`: the API
 * authenticates with a bearer header, which an `<img>` request would not
 * carry, so the browser would render a broken image for a 401. The object URL
 * is revoked when it is replaced or the panel unmounts - without that, every
 * poll of this page would leak a few hundred kilobytes.
 */
function Screenshot({ endpointId, outcome, capture }) {
  const [url, setUrl] = useState(null)
  const [failed, setFailed] = useState(false)
  // The ETag of what is on screen. A background refresh re-reads the capture
  // list every few seconds, and without this the image would be re-fetched and
  // the object URL churned on every one of them.
  const loaded = useRef(null)

  useEffect(() => {
    if (!capture.has_image) return undefined
    const token = `${outcome}:${capture.image_captured_at || ''}`
    if (loaded.current === token) return undefined

    let cancelled = false
    let objectUrl = null
    setFailed(false)
    endpointsApi
      .captureImage(endpointId, outcome)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        loaded.current = token
        setUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous)
          return objectUrl
        })
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [endpointId, outcome, capture.has_image, capture.image_captured_at])

  // Separate from the effect above so the URL is released on unmount without
  // re-running the fetch every time a dependency changes.
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])

  if (!capture.has_image) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-xs text-slate-500 dark:border-navy-700 dark:text-slate-400">
        <ImageOff size={15} className="mt-px shrink-0 text-slate-400" aria-hidden="true" />
        <span>
          {capture.image_error ||
            'No screenshot. Turn on “Also capture a screenshot” for this endpoint to render one on the next check.'}
        </span>
      </div>
    )
  }

  if (failed) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-xs text-slate-500 dark:border-navy-700 dark:text-slate-400">
        The screenshot could not be loaded.
      </div>
    )
  }

  if (!url) {
    return <div className="skeleton aspect-[16/10] w-full rounded-lg" />
  }

  return (
    <figure className="m-0">
      <a href={url} target="_blank" rel="noopener noreferrer" title="Open full size">
        <img
          src={url}
          alt={`${OUTCOME_LABEL[outcome] || outcome} for this endpoint`}
          className="w-full rounded-lg border border-slate-200 bg-white object-cover dark:border-navy-700 dark:bg-navy-800"
          loading="lazy"
        />
      </a>
      <figcaption className="mt-1.5 text-[11px] text-slate-400">
        {capture.image_width}×{capture.image_height}
        {capture.image_bytes ? ` · ${formatBytes(capture.image_bytes)}` : ''}
        {capture.image_captured_at
          ? ` · rendered ${formatRelative(capture.image_captured_at)}`
          : ''}
      </figcaption>
    </figure>
  )
}

/** The response body, with the bits that make it readable. */
function Body({ capture, onCopy, copied }) {
  if (!capture.body) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-xs text-slate-500 dark:border-navy-700 dark:text-slate-400">
        {capture.body_bytes
          ? `The response was ${formatBytes(capture.body_bytes)} of ${capture.content_type || 'binary data'}, which is not kept as text.`
          : 'The response had no body.'}
      </p>
    )
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <FileText size={12} aria-hidden="true" />
          Response body
        </span>
        <button type="button" className="btn-ghost btn-sm" onClick={onCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="max-h-80 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11px] leading-relaxed text-slate-800 dark:border-navy-700 dark:bg-navy-950 dark:text-slate-200">
        {capture.body}
      </pre>
      {capture.body_truncated ? (
        <p className="mt-1 text-[11px] text-slate-400">
          Showing the first {formatBytes(capture.body.length)}
          {capture.body_bytes ? ` of ${formatBytes(capture.body_bytes)}` : ''}.
        </p>
      ) : null}
    </div>
  )
}

/** One capture: what the endpoint returned, and when. */
function Capture({ endpointId, capture }) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (await copyToClipboard(capture.body || '')) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      toast.error('Could not copy to the clipboard.')
    }
  }

  return (
    <div className="card relative overflow-hidden">
      <span
        className={clsx(
          'absolute inset-y-0 left-0 w-1',
          OUTCOME_ACCENT[capture.outcome] || 'bg-slate-300',
        )}
        aria-hidden="true"
      />
      <div className="space-y-3 p-4 pl-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {OUTCOME_LABEL[capture.outcome] || capture.outcome}
            </h3>
            <StatusBadge status={capture.status} size="sm" />
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {formatDateTime(capture.captured_at)}
            <span className="text-slate-400"> · {formatRelative(capture.captured_at)}</span>
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-slate-400">HTTP status</dt>
            <dd className="tnum font-medium text-slate-800 dark:text-slate-100">
              {capture.http_status_code ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Response time</dt>
            <dd className="tnum font-medium text-slate-800 dark:text-slate-100">
              {capture.response_time_ms != null ? formatMs(capture.response_time_ms) : '—'}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-slate-400">Content type</dt>
            <dd className="truncate font-medium text-slate-800 dark:text-slate-100">
              {(capture.content_type || '—').split(';')[0]}
            </dd>
          </div>
        </dl>

        {capture.error_message ? (
          <p className="rounded-lg bg-red-50 px-2.5 py-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
            {capture.error_message}
          </p>
        ) : null}

        <Screenshot
          endpointId={endpointId}
          outcome={capture.outcome}
          capture={capture}
        />

        <Body capture={capture} onCopy={copy} copied={copied} />
      </div>
    </div>
  )
}

/**
 * What this endpoint returned, the last time it passed and the last time it
 * failed.
 *
 * Exactly those two, and no more: each new result replaces the one it
 * supersedes, so this panel is never a history to page through. That is
 * deliberate - the question it answers is "what did it look like when it
 * broke", which needs one good record, not a thousand.
 */
export default function CapturePanel({ endpointId, captures, loading }) {
  const toast = useToast()

  if (loading && !captures) {
    return <LoadingBlock rows={6} />
  }

  if (!captures?.length) {
    return (
      <Card>
        <EmptyState
          icon={Camera}
          title="Nothing captured yet"
          description="The response from the next check will be kept here, and the one after a failure alongside it."
        />
      </Card>
    )
  }

  const success = captures.find((item) => item.outcome === 'success')
  const failure = captures.find((item) => item.outcome === 'failure')

  const download = async (capture) => {
    try {
      const blob = await endpointsApi.captureImage(endpointId, capture.outcome)
      saveBlob(blob, `capture-${capture.outcome}.jpg`)
    } catch {
      toast.error('The screenshot could not be downloaded.')
    }
  }

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3 text-xs text-slate-500 dark:text-slate-400">
        <span className="font-medium text-slate-700 dark:text-slate-200">
          Two records, kept forever
        </span>
        <span>
          The last pass and the last failure. Each new result replaces the one
          before it, so nothing accumulates.
        </span>
        {captures.some((item) => item.has_image) ? (
          <span className="ml-auto flex gap-1.5">
            {captures
              .filter((item) => item.has_image)
              .map((item) => (
                <button
                  key={item.outcome}
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => download(item)}
                >
                  <Download size={13} /> {item.outcome}
                </button>
              ))}
          </span>
        ) : null}
      </div>

      {/* Success first, so the pair reads "this is normal, this is what went
          wrong" rather than in whatever order they happened to be written. */}
      <div className="grid gap-4 xl:grid-cols-2">
        {success ? <Capture endpointId={endpointId} capture={success} /> : null}
        {failure ? <Capture endpointId={endpointId} capture={failure} /> : null}
      </div>
    </div>
  )
}
