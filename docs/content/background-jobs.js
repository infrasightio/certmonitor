DOCS.page({
  id: 'background-jobs',
  title: 'Background processing',
  description: 'Every background process in the system: what triggers it, what it reads and writes, how often it runs, and what happens when it fails.',
  body: [

    DOCS.callout('note', 'There is no task queue',
      '<p>No Celery, no RQ, no Redis-backed job broker. Every background process is an asyncio task ' +
      'inside the worker, and the &ldquo;queue&rdquo; is the <code>endpoints</code> table itself: ' +
      'work is whatever is due, claimed with <code>SELECT ... FOR UPDATE SKIP LOCKED</code> and a ' +
      'lease. Redis is used for login rate limits and import previews, never for scheduling.</p>'),

    `<h2>The five worker tasks</h2>`,

    DOCS.table(['Task', 'Interval', 'Controlled by'], [
      ['<a href="#/background-jobs#the-check-loop">Check loop</a>',
       'Continuous; polls every 5s when there is nothing due',
       '<code>WORKER_POLL_INTERVAL_SECONDS</code>'],
      ['<a href="#/background-jobs#heartbeat">Heartbeat</a>', '15s', '<code>WORKER_HEARTBEAT_SECONDS</code>'],
      ['<a href="#/background-jobs#retention-sweep">Retention sweep</a>', '1 hour',
       '<code>RETENTION_SWEEP_INTERVAL_SECONDS</code>'],
      ['<a href="#/background-jobs#ssl-sweep">SSL sweep</a>', '1 hour',
       '<code>SSL_SWEEP_INTERVAL_SECONDS</code>, a module constant'],
      ['<a href="#/background-jobs#vantage-status-refresh">Vantage status refresh</a>', '15 minutes',
       '<code>VANTAGE_STATUS_INTERVAL_SECONDS</code>']
    ]),

    `<p>All five wait on a shared <code>asyncio.Event</code> rather than sleeping blindly, so a
    SIGTERM interrupts them immediately instead of at the end of an interval.</p>`,

    `<h2>The check loop</h2>`,

    DOCS.table(['Aspect', 'Detail'], [
      ['<strong>Trigger</strong>', 'Continuous. Each cycle claims whatever is due.'],
      ['<strong>Frequency</strong>',
       'Immediately again when the last batch came back full &mdash; there is probably more work ' +
       'waiting. Otherwise it waits <code>WORKER_POLL_INTERVAL_SECONDS</code>.'],
      ['<strong>Reads</strong>',
       '<code>endpoints</code> (the due query), <code>system_settings</code> (through a 10-second ' +
       'in-process cache), <code>incidents</code> (is one open?), <code>ssl_certificates</code> ' +
       '(the current row), <code>alerts</code> (the cooldown check), <code>rcas</code> (is the ' +
       'regroupable incident already written up?)'],
      ['<strong>Writes</strong>',
       '<code>monitoring_results</code>, <code>endpoints</code>, <code>ssl_certificates</code>, ' +
       '<code>incidents</code>, <code>alerts</code>, <code>endpoint_captures</code>'],
      ['<strong>Concurrency</strong>',
       '<code>WORKER_CONCURRENCY</code> (default 50) in-flight checks, each in its own session and ' +
       'transaction'],
      ['<strong>Batch size</strong>',
       '<code>min(WORKER_BATCH_SIZE, concurrency * 4)</code> &mdash; never more than the concurrency ' +
       'budget can absorb, or leases start expiring while work is still queued'],
      ['<strong>Lease</strong>',
       '<code>max(60, DEFAULT_TIMEOUT * 3 + 60)</code> seconds, long enough to cover the slowest ' +
       'possible check plus the time spent writing its result'],
      ['<strong>Logs</strong>',
       '<code>cycle_claimed</code> (debug), <code>check_recorded</code> (info, one per check), ' +
       '<code>incident_opened</code>, <code>incident_resolved</code>, ' +
       '<code>incident_withheld</code>, <code>alert_raised</code>, ' +
       '<code>check_cycle_error</code>, <code>cycle_failed</code>, <code>claim_failed</code>']
    ]),

    `<h3>Failure handling</h3>`,

    DOCS.table(['Failure', 'Consequence'], [
      ['The claim query fails',
       'Logged as <code>claim_failed</code>, the transaction rolls back, the cycle returns zero and ' +
       'the loop waits for the next poll'],
      ['One endpoint’s check raises',
       'Logged as <code>check_cycle_error</code> with the endpoint id, and its lease is released ' +
       'with <code>next_check_at = now + 60s</code>. <code>asyncio.gather</code> runs with ' +
       '<code>return_exceptions=True</code>, so the other checks in the batch are unaffected.'],
      ['Recording raises mid-way',
       'The reschedule is in a <code>finally</code> block, so <code>next_check_at</code> is re-armed ' +
       'and the lease is dropped regardless &mdash; otherwise a persistently failing endpoint would ' +
       'be retried in a tight loop'],
      ['The whole cycle raises',
       'Logged as <code>cycle_failed</code> with a traceback; the loop continues'],
      ['The worker process dies',
       'Leases expire and the endpoints become claimable again. Nothing is lost, and nothing needs ' +
       'to be cleaned up by hand.']
    ]),

    DOCS.callout('warn', 'There is no per-check retry queue',
      '<p>A failed check is a <em>recorded result</em>, not a job to be retried. The only retry that ' +
      'exists is <code>check_retry_attempts</code> inside a single probe, it is off by default, and ' +
      'it only ever covers transport-level failures. Everything else waits for the next scheduled ' +
      'check &mdash; which, for a failing endpoint, is <code>failure_recheck_interval</code> away ' +
      '(60 seconds by default), not a full interval.</p>'),

    `<h2>Heartbeat</h2>`,

    DOCS.table(['Aspect', 'Detail'], [
      ['<strong>Trigger</strong>', 'Timer, every <code>WORKER_HEARTBEAT_SECONDS</code> (15s)'],
      ['<strong>Writes</strong>',
       '<code>worker_heartbeats</code>: <code>last_seen_at</code>, <code>checks_completed</code>, ' +
       '<code>checks_failed</code>, <code>in_flight</code>, <code>version</code>, ' +
       '<code>region</code>, and self-measured <code>cpu_percent</code>, <code>memory_mb</code>, ' +
       '<code>memory_limit_mb</code>'],
      ['<strong>Read by</strong>', '<code>/health</code> and <code>GET /api/workers</code>'],
      ['<strong>Failure</strong>',
       'A <code>SQLAlchemyError</code> is caught, rolled back and logged as ' +
       '<code>heartbeat_write_failed</code>. The loop continues; a missed beat only affects what ' +
       '<code>/health</code> reports.']
    ]),

    `<h3>Retiring dead workers</h3>
    <p>A live worker rewrites its row every 15 seconds, so a heartbeat older than the stale window
    cannot belong to a running process &mdash; it is a container that was replaced. Deleting it is
    safe even if the judgement is wrong: the owner simply recreates the row on its next beat, because
    the writer inserts when the row is missing.</p>`,

    DOCS.diagram(`
  worker startup
     +-- write our own heartbeat row FIRST
     +-- then delete every row older than WORKER_STALE_AFTER_SECONDS
         belonging to anyone else
         (at this instant a stale row cannot be a running worker, so this
          immediately clears rows left by containers we replaced)

  every 20 beats (~5 minutes at the default cadence)
     +-- delete rows older than
         max(WORKER_STALE_AFTER_SECONDS * 2, WORKER_RETIRE_AFTER_SECONDS)
         (a wider window than the startup sweep, so a briefly wedged peer
          is given room to recover before its row is removed)

  clean shutdown
     +-- delete our own row, in the same transaction that releases our leases
`, 'This is what stops a single rebuild from pinning /health at "degraded" while an orphan row ages out. A 30-minute retire window made every rebuild look degraded for half an hour, which is why the default is 300 seconds.'),

    `<h2>Retention sweep</h2>`,

    DOCS.table(['Aspect', 'Detail'], [
      ['<strong>Trigger</strong>', 'Timer, every <code>RETENTION_SWEEP_INTERVAL_SECONDS</code> (3600s)'],
      ['<strong>First run</strong>',
       'Staggered by <code>30 + (pid % 60)</code> seconds, so several replicas starting together do ' +
       'not all begin deleting at the same moment'],
      ['<strong>Reads</strong>',
       'Settings with <code>use_cache=False</code> &mdash; this loop is slow enough to take the truth'],
      ['<strong>Deletes from</strong>',
       '<code>monitoring_results</code>, <code>ssl_certificates</code> (superseded only), ' +
       '<code>alerts</code>, <code>incidents</code> (resolved only), <code>audit_logs</code>'],
      ['<strong>Batching</strong>',
       '5000 rows at a time, committing between batches, capped at 200 batches per table per sweep ' +
       '&mdash; so the sweep never holds a long transaction or a table-wide lock while the worker is ' +
       'writing results'],
      ['<strong>Logs</strong>',
       '<code>retention_sweep_completed</code> with per-table counts when anything was deleted; ' +
       '<code>retention_sweep_nothing_to_do</code> at debug otherwise; ' +
       '<code>retention_sweep_failed</code> on error'],
      ['<strong>Failure</strong>',
       'Rolled back and logged, then re-raised to the loop, which logs ' +
       '<code>retention_sweep_error</code> and waits for the next interval. Already-committed ' +
       'batches stay deleted.']
    ]),

    DOCS.callout('tip', 'Safe on several replicas at once',
      '<p>The sweep selects ids matching a cutoff and deletes by id. Two replicas sweeping ' +
      'simultaneously simply find fewer rows each; there is no coordination and none is needed.</p>'),

    `<h2>SSL sweep</h2>`,

    DOCS.table(['Aspect', 'Detail'], [
      ['<strong>Trigger</strong>', 'Timer, hourly. First run 45 seconds after startup.'],
      ['<strong>Why it exists</strong>',
       'Certificates expire on the calendar, not on a check schedule. Without it, an endpoint on a ' +
       'one-hour interval could cross the warning threshold and stay silent until its next check, ' +
       'and editing a threshold would only take effect as each endpoint happened to be checked.'],
      ['<strong>Reads</strong>',
       'Every <code>is_current</code> certificate; their endpoints, with tags and environment'],
      ['<strong>Writes</strong>',
       '<code>ssl_certificates.days_remaining</code> and <code>status</code> where either changed; ' +
       'the matching <code>endpoints.ssl_*</code> columns; <code>alerts</code> for certificates now ' +
       'in an alertable state'],
      ['<strong>Alert scope</strong>',
       'Only endpoints with both <code>ssl_monitoring_enabled</code> and <code>alerts_enabled</code>, ' +
       'and only when the global <code>alerts_enabled</code> setting is on. The alert cooldown is ' +
       'what stops this re-notifying every hour for the same certificate.'],
      ['<strong>Logs</strong>',
       '<code>certificates_regraded</code>, <code>ssl_sweep_completed</code>, ' +
       '<code>ssl_sweep_error</code>']
    ]),

    `<h2>Vantage status refresh</h2>`,

    DOCS.table(['Aspect', 'Detail'], [
      ['<strong>Trigger</strong>',
       'Timer, every <code>VANTAGE_STATUS_INTERVAL_SECONDS</code> (900s). First run 20 seconds after ' +
       'startup, ahead of the first confirmations, so the resources page has something to show ' +
       'rather than &ldquo;not observed yet&rdquo; for the first quarter hour.'],
      ['<strong>Runs at all only when</strong>',
       'Vantage points are configured <em>and</em> <code>VANTAGE_ECHO_URL</code> is set. A deployment ' +
       'without them never reaches out to anything.'],
      ['<strong>Does</strong>',
       'One request per vantage, through its proxy, to the echo URL; stores the observed IP, country ' +
       'and city'],
      ['<strong>Writes</strong>', '<code>vantage_status</code>, one row per configured vantage'],
      ['<strong>Why it is slow on purpose</strong>',
       'An exit changes when Tor rebuilds a circuit, not between one request and the next, and each ' +
       'pass costs one external request per vantage'],
      ['<strong>Failure</strong>',
       'Caught and logged as <code>vantage_status_error</code> with the message truncated to 200 ' +
       'characters. Nothing else is affected.']
    ]),

    `<h2>Screenshot rendering</h2>
    <p>Not a loop &mdash; an event-triggered background task, spawned after a check commits.</p>`,

    DOCS.table(['Aspect', 'Detail'], [
      ['<strong>Trigger</strong>',
       'A committed check on an endpoint where <code>SCREENSHOT_ENABLED</code>, ' +
       '<code>endpoint.screenshot_enabled</code> and <code>check_type == http</code> all hold'],
      ['<strong>Why after the commit</strong>',
       'Rendering a page takes seconds. Inside the transaction it would hold a row lock and a ' +
       'connection open for the duration, and a slow page would delay the thing the worker actually ' +
       'exists to do.'],
      ['<strong>Concurrency</strong>',
       '<code>SCREENSHOT_CONCURRENCY</code> (default 2), deliberately far below ' +
       '<code>WORKER_CONCURRENCY</code>: 50 concurrent HTTP checks is nothing, 50 concurrent ' +
       'Chromium pages is several gigabytes'],
      ['<strong>Browser</strong>',
       'One Chromium process for the lifetime of the worker, not one per capture &mdash; launching ' +
       'it costs about a second and a lot of page faults'],
      ['<strong>Writes</strong>',
       'Merges the image into whichever <code>endpoint_captures</code> row is current for that ' +
       'outcome'],
      ['<strong>Failure</strong>',
       'Swallowed entirely and recorded as <code>image_error</code> on the capture row. Nothing ' +
       'about the endpoint’s status, incidents or alerts depends on a screenshot, so no failure ' +
       'here is allowed to surface as a worker error. If Chromium is missing at all, that is ' +
       'recorded once rather than producing one traceback per check forever.'],
      ['<strong>Shutdown</strong>',
       'In-flight renders get up to 10 seconds to finish before being cancelled &mdash; one is ' +
       'already most of the way through, and a captured screenshot is worth more than a couple of ' +
       'seconds of shutdown']
    ]),

    `<h2>Processes outside the worker</h2>`,

    DOCS.table(['Process', 'Runs where', 'When'], [
      ['<strong>Bootstrap seeding</strong>', 'API container, as its own entrypoint step',
       'Every start. Idempotent, and serialised across replicas by a PostgreSQL advisory lock.'],
      ['<strong>Alembic migrations</strong>', 'API container entrypoint, role <code>api</code>',
       'Every start, before seeding. The worker waits for the schema instead.'],
      ['<strong>Notification delivery</strong>',
       'Inline in whichever process raised the alert',
       'Immediately, with up to 3 attempts and exponential backoff. Never raises to the caller.'],
      ['<strong>Post-deployment health check</strong>', 'API request, inline',
       'When a deployment completes or fails, if <code>change_health_check_on_resume</code> is on. ' +
       'Bounded at 40 endpoints, 10 concurrent.'],
      ['<strong>Settings cache refresh</strong>', 'In-process, both processes',
       'Lazily, 10 seconds after the last load. This is why a settings change takes effect within ' +
       'about ten seconds rather than instantly or at restart.'],
      ['<strong>Import preview expiry</strong>', 'Redis TTL, or an in-process TTL cache',
       '15 minutes after the preview was created']
    ]),

    `<h2>Observing background work</h2>`,

    DOCS.code(`# Follow the worker
docker compose logs -f worker

# What the API thinks of the worker fleet
curl -s http://localhost:8080/health | jq '.components.monitoring_worker'

# Per-worker detail (needs settings:read)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/workers | jq

# Is anything actually due?
docker compose exec -T postgres psql -U infrasight -d infrasight -c \\
  "SELECT count(*) FILTER (WHERE next_check_at <= now()) AS due,
          count(*) FILTER (WHERE leased_by IS NOT NULL) AS leased,
          count(*) AS total
   FROM endpoints WHERE monitoring_enabled AND NOT is_paused;"`, 'shell'),

    DOCS.callout('note', 'Log events worth alerting on yourself',
      '<p><code>claim_failed</code>, <code>cycle_failed</code>, ' +
      '<code>retention_sweep_failed</code>, <code>heartbeat_write_failed</code> and ' +
      '<code>bootstrap_failed</code> all indicate something wrong with InfraSight rather than with ' +
      'what it is watching. <code>check_cycle_error</code> is per-endpoint and is more often a ' +
      'symptom of the target.</p>')

  ].join('\n')
});
