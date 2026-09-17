DOCS.page({
  id: 'architecture',
  title: 'Architecture',
  description: 'The process model, the module layout on both sides, and the rules that keep the API and the worker in step.',
  body: [

    `<h2>The shape of the system</h2>
    <p>InfraSight is two Python processes over one PostgreSQL database, with a React SPA served by
    nginx in front. The split is the central design decision, and almost everything else follows
    from it.</p>`,

    DOCS.table(['Process', 'Responsibility', 'Explicitly not its job'], [
      ['<strong>API</strong> <br><code>app/main.py</code>',
       'Serve HTTP: authentication, CRUD, aggregation, workflow transitions, on-demand diagnostics ' +
       'and manual checks.',
       'Scheduled endpoint checks. Nothing in <code>main.py</code> probes anything, so a slow ' +
       'monitored host can never delay an API request.'],
      ['<strong>Worker</strong> <br><code>app/workers/monitor_worker.py</code>',
       'Claim due endpoints, probe them, record results, drive status transitions, manage incidents, ' +
       'raise alerts, and run three periodic sweeps.',
       'Serving HTTP. It exposes no port; liveness is a heartbeat row.'],
      ['<strong>Frontend</strong> <br>nginx + built SPA',
       'Serve the bundle, and reverse-proxy <code>/api</code>, <code>/health</code>, ' +
       '<code>/ready</code>, <code>/live</code> and <code>/branding</code> to the API on the same ' +
       'origin.',
       'Holding state. The SPA keeps only tokens and a cached user object in <code>localStorage</code>.']
    ]),

    DOCS.callout('note', 'One image, two entrypoints',
      '<p><code>backend/Dockerfile</code> builds a single image that both the <code>backend</code> ' +
      'and <code>worker</code> services run, with different arguments. Shipping one artefact means ' +
      'the worker cannot drift out of sync with the API&rsquo;s models or check logic &mdash; the ' +
      'exact scenario that produces &ldquo;the dashboard says UP but the worker disagrees&rdquo;.</p>'),

    `<h2>Backend module layout</h2>`,

    DOCS.diagram(`
backend/app/
|
+-- main.py            FastAPI factory: middleware, exception handlers, lifespan
+-- bootstrap.py       idempotent first-boot seeding, guarded by an advisory lock
|
+-- core/
|     config.py        pydantic-settings; every env var, read once at import
|     database.py      one pooled async engine per process; get_db / session_scope
|     enums.py         every domain enum, stored as short strings not PG ENUMs
|     security.py      bcrypt, JWT issue/verify, Fernet encrypt/decrypt
|     ratelimit.py     Redis-backed sliding window, in-process fallback
|     logging.py       structlog; JSON in production, redaction processor
|
+-- models/            SQLAlchemy declarative models (the schema)
+-- schemas/           Pydantic request/response models (the API contract)
|
+-- api/
|     deps.py          auth, permission gates, pagination, feature gates
|     health.py        /health /ready /live + /api/workers, resources, vantages
|     branding.py      unauthenticated /branding and /branding/logo
|     routes/          one module per resource, aggregated in routes/__init__.py
|
+-- services/          all business logic; routes stay thin
|     monitoring_service.py    the ONLY writer of check results and status
|     alert_service.py         cooldown + alert rows
|     notification_service.py  delivery to webhook/Slack/Teams/PagerDuty/email
|     change_service.py        change workflow, pause/resume attribution
|     rca_service.py           RCA workflow, ownership, analytics
|     diagnostics_service.py   layered probing + evidence gathering
|     diagnosis_reasoning.py   evidence -> ranked candidates + actions
|     stats_service.py         every dashboard aggregate
|     ... plus endpoint, user, settings, audit, capture, vantage,
|         resource, retention, insights, import_export, preview_store
|
+-- monitoring/        the probe itself - imports nothing from services/
|     checker.py       run_check(): DNS, transport, protocol, certificate
|     transport.py     httpx client wrapped to time connect and TLS phases
|     ssl_inspect.py   X.509 parsing, chain, hostname match, classification
|     validators.py    URL parsing, blocked-address policy, clamps
|     screenshot.py    optional Playwright render
|     network.py       what a hostname resolves to, and what those addresses are
|
+-- workers/
      monitor_worker.py  claim -> probe -> record -> reschedule, plus sweeps
`, 'The dependency direction is one-way: monitoring/ knows nothing about services/, which is what lets the same probe run from the worker, from a manual check, and from a test with no database.'),

    `<h3>The layering rule</h3>
    <p>A route handler validates, calls one or more services, records an audit entry, commits, and
    serialises. It does not contain business logic. Two consequences worth knowing:</p>

    <ul>
      <li><strong><code>monitoring_service.record_check_result</code> is the only function that turns
      a check into database state.</strong> It owns the <code>monitoring_results</code> row, the
      endpoint status machine, incident open/close, certificate history and alert generation. The
      worker and the manual-check route both call it, so they cannot diverge.</li>
      <li><strong><code>app.monitoring.checker.run_check</code> touches no database.</strong> It takes
      a <code>CheckTarget</code> value object and returns a <code>CheckOutcome</code>. That is what
      lets <code>POST /api/endpoints/{id}/check?persist=false</code> run a real probe as a
      configuration dry run without writing anything.</li>
    </ul>`,

    `<h2>The API process</h2>

    <h3>Middleware, outermost first</h3>`,

    DOCS.diagram(`
   request
     |
     v
  SecurityHeadersMiddleware     nosniff, DENY framing, no-referrer,
     |                          restrictive CSP, Cache-Control: no-store,
     |                          HSTS when is_production and HSTS_ENABLED
     v
  RequestContextMiddleware      assigns/echoes X-Request-ID, binds structlog
     |                          contextvars, emits one access line with
     |                          duration, sets X-Response-Time-Ms
     v
  GZipMiddleware                minimum_size=1024
     v
  CORSMiddleware                only added when CORS_ORIGINS is non-empty
     v
  TrustedHostMiddleware         only added when ALLOWED_HOSTS is non-empty
     v
  router -> dependencies -> handler
`, 'Probe paths (/health, /ready, /live, /metrics) are excluded from the access log so constant polling does not drown the signal.'),

    DOCS.callout('note', 'Why the access log reads a snapshot, not the user object',
      '<p><code>RequestContextMiddleware</code> runs outside the request-scoped database session, so ' +
      'reading an attribute off the ORM <code>User</code> there hits a detached instance and raises ' +
      '<code>DetachedInstanceError</code> &mdash; which used to turn a perfectly good response into ' +
      'a 500. <code>get_current_user</code> therefore snapshots <code>username</code>, ' +
      '<code>user_id</code> and <code>role</code> onto <code>request.state</code> as plain strings, ' +
      'and the middleware reads those.</p>'),

    `<h3>Exception handlers</h3>
    <p>Registered in <code>_register_exception_handlers</code>. The shape of an error body is part of
    the contract the SPA depends on.</p>`,

    DOCS.table(['Exception', 'Status', 'Body'], [
      ['<code>RequestValidationError</code>', '422',
       '<code>{detail, code: "validation_error", fields: {field: message}}</code> &mdash; flattened ' +
       'into a per-field map, because the default FastAPI payload is awkward to render in a form.'],
      ['<code>UrlValidationError</code>', '400',
       '<code>{detail, code: "invalid_url"}</code>'],
      ['<code>IntegrityError</code>', '409',
       '<code>{detail, code: "conflict"}</code> &mdash; a generic conflict message. The driver text ' +
       'can contain table and column names, so it goes to the log, not the response.'],
      ['<code>SQLAlchemyError</code>', '503',
       '<code>{detail, code: "database_error"}</code>'],
      ['<code>HTTPException</code>', 'as raised',
       '<code>{detail}</code>, preserving any headers the raiser set'],
      ['<em>anything else</em>', '500',
       '<code>{detail, code: "internal_error", request_id}</code> &mdash; never the exception text. ' +
       'The request id ties the response back to the full detail in the log.']
    ]),

    `<h3>Lifespan</h3>
    <p>On startup the API logs <code>api_starting</code> and runs the bootstrap. Configuration is
    validated before that, and a production or staging environment with no <code>JWT_SECRET</code>
    is rejected outright rather than started &mdash; a generated secret differs per replica and per
    restart, which costs every session and every stored credential. Where a secret was generated
    (development, testing) startup logs <code>generated_jwt_secret</code>; a supplied secret shorter
    than 32 characters in production logs <code>weak_jwt_secret</code>. A bootstrap failure is
    logged as <code>bootstrap_failed</code> and <em>does not</em> crash the container: <code>/ready</code>
    keeps reporting not-ready, which is the signal an operator needs while migrations catch up. On
    shutdown it closes the rate limiter and disposes the engine.</p>`,

    `<h2>The worker process</h2>
    <p>Five concurrent tasks under one asyncio event loop.</p>`,

    DOCS.diagram(`
  MonitorWorker.run()
     |
     +-- heartbeat        every WORKER_HEARTBEAT_SECONDS (15s)
     |                    writes worker_heartbeats; retires dead peers
     |
     +-- checks           the main loop: claim -> probe -> record -> reschedule
     |
     +-- retention        every RETENTION_SWEEP_INTERVAL_SECONDS (3600s)
     |                    batched deletes across five tables
     |
     +-- ssl-sweep        every 3600s (module constant)
     |                    recompute days_remaining, re-grade, raise expiry alerts
     |
     +-- vantage-status   every VANTAGE_STATUS_INTERVAL_SECONDS (900s)
                          only when vantages and an echo URL are configured
`, 'All five stop on SIGINT or SIGTERM through a shared asyncio.Event.'),

    `<h3>The check loop</h3>`,

    DOCS.diagram(`
  _run_cycle()
     |
     +-- load runtime settings (10s in-process cache)
     |
     +-- _claim_due_endpoints(limit)
     |      SELECT id FROM endpoints
     |       WHERE monitoring_enabled AND NOT is_paused
     |         AND (next_check_at IS NULL OR next_check_at <= now)
     |         AND (lease_expires_at IS NULL OR lease_expires_at < now)
     |       ORDER BY next_check_at NULLS FIRST
     |       LIMIT n
     |       FOR UPDATE SKIP LOCKED          <- PostgreSQL only
     |      then UPDATE ... SET lease_expires_at = now + max(60, timeout*3 + 60),
     |                         leased_by = worker_id
     |
     +-- asyncio.gather over the claimed ids, each under a
     |   Semaphore(WORKER_CONCURRENCY) and in its OWN session
     |
     +-- if the batch came back full, poll again immediately;
         otherwise wait WORKER_POLL_INTERVAL_SECONDS
`, 'limit = min(WORKER_BATCH_SIZE, concurrency * 4). Never claim more than the concurrency budget can absorb, or leases start expiring while work is still queued.'),

    DOCS.callout('tip', 'Horizontal scaling needs no coordination',
      '<p><code>SKIP LOCKED</code> plus a lease is the whole mechanism. Any number of worker ' +
      'replicas can run against one database without ever checking the same endpoint twice, and a ' +
      'worker that dies mid-batch releases its endpoints when the lease expires rather than ' +
      'stranding them. <code>docker compose up -d --scale worker=3</code> works with no ' +
      'configuration change.</p>'),

    `<h3>Worker identity</h3>
    <p>The worker id must be unique per running process &mdash; two workers sharing one id overwrite
    each other&rsquo;s heartbeat, so a scaled fleet reports as one worker and <code>/health</code>
    undercounts it. It is resolved as <code>WORKER_ID</code>, else the hostname, else
    <code>"worker"</code>, truncated to 64 characters.</p>

    <p>In Compose the <code>worker</code> service deliberately declares no
    <code>container_name</code> and no <code>hostname</code>: both are single-instance settings, and
    each replica therefore takes its container ID. That id is not stable across restarts, and does not
    need to be:</p>

    <ul>
      <li>A clean shutdown deletes the worker&rsquo;s own heartbeat row and releases everything it
      leased, in one transaction.</li>
      <li>A row left behind by a hard kill is removed by the next worker&rsquo;s startup sweep, and
      again roughly every five minutes by the heartbeat loop.</li>
    </ul>

    <p>Set <code>WORKER_ID</code> explicitly only when you want a fixed label in the fleet view, and
    it must then differ per replica (in Kubernetes, the pod name via
    <code>fieldRef: metadata.name</code>).</p>`,

    `<h3>Graceful shutdown</h3>`,

    DOCS.diagram(`
  SIGTERM / SIGINT
     |
     +-- log worker_draining (in_flight, screenshots_in_flight, checks_completed)
     +-- cancel the five tasks and gather them
     +-- give in-flight screenshot renders up to 10s to finish, then cancel
     +-- screenshot.shutdown()          close the shared Chromium process
     +-- one transaction:
     |      UPDATE endpoints SET lease_expires_at = NULL, leased_by = NULL
     |            WHERE leased_by = <this worker>
     |      DELETE FROM worker_heartbeats WHERE worker_id = <this worker>
     +-- dispose_engine()
     +-- log worker_stopped
`, 'stop_grace_period is 45s for the worker in Compose, which is what this sequence needs.'),

    `<h2>Frontend architecture</h2>

    <h3>Provider stack</h3>`,

    DOCS.diagram(`
  BrowserRouter
    └── ToastProvider          transient notifications
          └── BrandingProvider   GET /branding, unauthenticated
                └── AuthProvider   session + permission set
                      └── FeaturesProvider   GET /api/features
                            └── App   routes
`, 'Branding sits above Auth because the sign-in screen has to render the deployment name and logo before there is a token.'),

    `<h3>Route gates</h3>
    <p>Three composable wrappers in <code>App.jsx</code>:</p>`,

    DOCS.table(['Gate', 'Behaviour'], [
      ['<code>RequireAuth</code>',
       'Redirects to <code>/login</code> when unauthenticated. If <code>must_change_password</code> ' +
       'is set, redirects to <code>/change-password</code> from anywhere else &mdash; the API refuses ' +
       'every other route in that state, so letting the user navigate would only produce 403s.'],
      ['<code>RequirePermission</code>',
       'Redirects to <code>/</code> when the signed-in role lacks the permission code.'],
      ['<code>RequireFeature</code>',
       'Redirects to <code>/</code> when an administrator has switched the module off. Cosmetic on ' +
       'its own &mdash; the API refuses those routes too &mdash; but it keeps a bookmarked URL from ' +
       'landing on a page that can only render errors.']
    ]),

    DOCS.callout('warn', 'Hiding a button is a courtesy, not a security boundary',
      '<p>Permissions arrive from the server with the user object and the UI uses them only to hide ' +
      'controls. Every action is authorised again server-side by the ' +
      '<code>require_permissions</code> dependency.</p>'),

    `<h3>The API client</h3>
    <p>One axios instance in <code>src/lib/api.js</code>, with four responsibilities kept out of
    components:</p>

    <ol>
      <li><strong>Attach the token</strong> from <code>localStorage</code> on every request.</li>
      <li><strong>Refresh once on a 401 and replay.</strong> Concurrent refreshes are serialised
      through a single shared promise &mdash; a dashboard load fires several requests at once, and all
      of them would otherwise try to refresh independently. Calls to <code>/auth/*</code> are excluded
      so a failed login does not trigger a refresh loop.</li>
      <li><strong>Normalise errors</strong> into <code>{message, status, fields, requestId}</code>.
      An HTML body means a proxy answered rather than the API, so the client keeps its own message;
      that is how a 502 renders as &ldquo;The API is not responding&hellip; check docker compose
      ps&rdquo; instead of a blank failure.</li>
      <li><strong>Notice the password-change signal</strong> &mdash; a 403 carrying
      <code>x-password-change-required</code> routes to the password screen.</li>
    </ol>`,

    `<h3>Bundling and polling</h3>
    <p>The Dashboard and Endpoints screens stay in the main bundle because they are what an operator
    opens first; every other screen is a <code>React.lazy</code> import. <code>vite.config.js</code>
    splits <code>react</code> and <code>recharts</code> into manual chunks, since charts are heavy and
    needed on two screens.</p>

    <p>Screens stay current through <code>useAutoRefresh</code> rather than a reload button, under
    three rules taken directly from the hook:</p>

    <ul>
      <li><strong>Nothing runs in a hidden tab.</strong> Polling stops on <code>visibilitychange</code>
      and resumes with an immediate fetch, so returning to a tab shows current data rather than a
      countdown.</li>
      <li><strong>A refresh never interrupts.</strong> Callers pass <code>paused</code> while the user
      is mid-edit; overwriting a half-written comment is worse than slightly stale data.</li>
      <li><strong>Overlaps are skipped, not queued.</strong> If a fetch is slower than the interval the
      next tick is dropped rather than stacking requests on a backend that is evidently already
      struggling.</li>
    </ul>

    <p>Two cadences are exported: <code>LIVE_INTERVAL</code> (10s) for conversation-like surfaces and
    <code>SLOW_INTERVAL</code> (30s) for aggregates.</p>`,

    `<h2>External integrations</h2>
    <p>The complete list of things InfraSight talks to that are not itself:</p>`,

    DOCS.table(['Integration', 'Direction', 'Optional?'], [
      ['<strong>Monitored endpoints</strong>', 'Outbound from the worker (and from the API for a ' +
       'manual check or a diagnosis)', 'No &mdash; this is the product'],
      ['<strong>Notification channels</strong> &mdash; webhook, Slack, Microsoft Teams, PagerDuty ' +
       'Events v2, SMTP', 'Outbound from whichever process raised the alert',
       'Yes. With no channels configured, alerts are still recorded and marked ' +
       '<code>skipped</code>.'],
      ['<strong>Vantage proxies</strong> (SOCKS5 or HTTP)', 'Outbound from the worker',
       'Yes. Unset <code>VANTAGE_POINTS</code> and the behaviour is exactly as before.'],
      ['<strong><code>VANTAGE_ECHO_URL</code></strong> (default <code>https://ifconfig.co/json</code>)',
       'Outbound from the worker, once per vantage per 15 minutes',
       'Yes. Blank it to stop asking anything external.'],
      ['<strong>Redis</strong>', 'Outbound from the API',
       'Yes for a single replica; effectively required for more than one.'],
      ['<strong>PostgreSQL</strong>', 'Outbound from both processes', 'No']
    ]),

    DOCS.callout('tip', 'No geolocation, no third-party lookups',
      '<p><code>app/monitoring/network.py</code> notes the deliberate absence: reverse DNS uses the ' +
      'same resolver the checks use, and there is no geo-IP call, because a private address has no ' +
      'region for anyone to return and posting the fleet&rsquo;s addresses to an external service ' +
      'would trade the property that nothing leaves this machine for an answer that is mostly ' +
      '&ldquo;unknown&rdquo;.</p>')

  ].join('\n')
});
