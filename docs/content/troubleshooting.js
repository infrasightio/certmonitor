DOCS.page({
  id: 'troubleshooting',
  title: 'Troubleshooting',
  description: 'Symptoms, the real log events and error strings behind them, and what to do. Every message quoted here comes from the source.',
  body: [

    `<h2>Start here</h2>`,

    DOCS.code(`docker compose ps                      # what is running, and is it healthy
docker compose logs --tail=100 backend
docker compose logs --tail=100 worker
curl -s http://localhost:8080/health | jq`, 'shell'),

    `<p>The <code>/health</code> body names which half is unhappy before you read a single log
    line:</p>`,

    DOCS.table(['Response', 'Means'], [
      ['<code>200</code> with <code>"status": "healthy"</code>', 'Both halves are fine'],
      ['<code>200</code> with <code>"status": "degraded"</code>',
       'The database is fine, the worker is not. <code>components.monitoring_worker.detail</code> ' +
       'says why.'],
      ['<code>503</code> with <code>"status": "unhealthy"</code>',
       'The database is unreachable from the API'],
      ['No response at all', 'nginx or the API container is down &mdash; check ' +
       '<code>docker compose ps</code> first']
    ]),

    `<h2>The application will not start</h2>`,

    DOCS.details('The backend exits immediately after start',
      `<p>Look at the first lines of <code>docker compose logs backend</code>. The entrypoint logs
      structured JSON before uvicorn ever runs.</p>` +
      DOCS.table(['Event', 'Means', 'Fix'], [
        ['<code>{"event":"database_unreachable"}</code>',
         'The entrypoint polled <code>SELECT 1</code> for <code>DB_WAIT_ATTEMPTS</code> &times; ' +
         '<code>DB_WAIT_DELAY</code> (120 seconds by default) and gave up',
         'Check <code>docker compose ps postgres</code>, then its logs. A wrong ' +
         '<code>POSTGRES_PASSWORD</code> or a database name that does not exist inside the volume ' +
         'both land here.'],
        ['An Alembic traceback after <code>running_migrations</code>',
         'A migration failed',
         'Read the error. A partially applied migration usually needs manual attention; take a dump ' +
         'first.'],
        ['A traceback from <code>python -m app.bootstrap</code>',
         'Seeding failed. This is deliberately fatal for the container &mdash; better than serving an ' +
         'API with no admin account.',
         'Usually a permissions problem on the database role.'],
        ['<code>ValueError: MIN_MONITOR_INTERVAL must be &gt;= 10 seconds</code>',
         'Configuration validation rejected the environment',
         'Fix the value in <code>.env</code>.'],
        ['<code>ValueError: SSL_CRITICAL_DAYS must be &lt;= SSL_WARNING_DAYS</code>',
         'Same, for the certificate thresholds',
         'Make critical the smaller number.']
      ])),

    DOCS.details('POSTGRES_PASSWORD must be set in .env',
      `<p>Compose refuses to start at all. The variable is declared with the
      <code>:?</code> error form precisely so this fails loudly rather than starting Postgres with a
      blank password.</p>` +
      DOCS.code(`cp .env.example .env
# then set POSTGRES_PASSWORD, JWT_SECRET and ADMIN_PASSWORD`, 'shell')),

    DOCS.details('The worker sits at "waiting_for_schema"',
      `<p>Expected during a first boot, while the API applies migrations. It polls for the
      <code>endpoints</code>, <code>monitoring_results</code> and <code>system_settings</code>
      tables for up to 180 seconds.</p>
      <p>If it then logs <code>schema_not_ready</code> and exits, the API never finished migrating.
      Fix the API first; the worker will come up on its restart.</p>`),

    `<h2>Nothing is being checked</h2>`,

    DOCS.details('The dashboard shows endpoints stuck at "unknown"',
      `<p>Work through this in order &mdash; it is the order the worker itself does.</p>` +
      DOCS.code(`# 1. Is a worker even running and reporting?
curl -s http://localhost:8080/health | jq '.components.monitoring_worker'

# 2. Is WORKER_ENABLED true? A false value logs "worker_disabled" and exits.
docker compose logs worker | grep -i worker_disabled

# 3. Is anything actually due?
docker compose exec -T postgres psql -U infrasight -d infrasight -c \\
  "SELECT count(*) FILTER (WHERE next_check_at <= now()) AS due,
          count(*) FILTER (WHERE leased_by IS NOT NULL) AS leased,
          count(*) FILTER (WHERE is_paused) AS paused,
          count(*) FILTER (WHERE NOT monitoring_enabled) AS disabled,
          count(*) AS total
   FROM endpoints;"

# 4. Is the worker claiming?
docker compose logs worker | grep -E 'cycle_claimed|claim_failed|check_recorded'`, 'shell') +
      DOCS.table(['Finding', 'Means'], [
        ['<code>no monitoring worker has registered yet</code>',
         'No worker has ever written a heartbeat. The container is not running, or cannot reach the ' +
         'database.'],
        ['<code>no worker heartbeat within 90s</code>',
         'A worker ran and stopped. Check its logs for a crash, and whether the container is ' +
         'restarting.'],
        ['High <code>paused</code> or <code>disabled</code> counts',
         'They are excluded from the claim query by design. Check <code>pause_reason</code> ' +
         '&mdash; a deployment that was never completed is the usual cause.'],
        ['<code>claim_failed</code>',
         'The claim query itself failed. A database problem, not a monitoring one.']
      ])),

    DOCS.details('Endpoints stay leased and are never checked again',
      `<p>A worker died mid-batch. Leases expire on their own after
      <code>max(60, DEFAULT_TIMEOUT * 3 + 60)</code> seconds and the endpoints become claimable
      again, so this resolves itself within about 90 seconds. To confirm:</p>` +
      DOCS.code(`docker compose exec -T postgres psql -U infrasight -d infrasight -c \\
  "SELECT leased_by, count(*), min(lease_expires_at)
   FROM endpoints WHERE leased_by IS NOT NULL GROUP BY leased_by;"`, 'shell') +
      `<p>If a lease is far in the future and its worker is gone, restarting the worker is safe: a
      clean shutdown releases everything it holds, and a fresh start reclaims whatever has
      expired.</p>`),

    DOCS.details('/health says "degraded" after every rebuild',
      `<p>This was a real bug, and the fix is worth knowing. A worker gets a fresh identity whenever
      its container is recreated, so every rebuild left its predecessor&rsquo;s heartbeat row behind
      &mdash; and one orphan row pinned the status at degraded until it aged out.</p>
      <p>Now: the retire window is <code>WORKER_RETIRE_AFTER_SECONDS</code> (300 seconds), a new
      worker sweeps stale peers on startup, and a clean shutdown deletes the worker&rsquo;s own row.
      If you still see this, check that you have not set <code>WORKER_ID</code> to a value shared by
      several replicas.</p>`),

    `<h2>An endpoint is marked down and you disagree</h2>`,

    DOCS.details('Read the failure reason first',
      DOCS.table(['<code>failure_reason</code>', 'Look at'], [
        ['<code>dns_failure</code>',
         'The container&rsquo;s resolver. <code>GET /api/endpoints/{id}/network</code> shows every ' +
         'address the name resolves to from where the worker runs.'],
        ['<code>connection_refused</code> / <code>connection_timeout</code>',
         'Network path and firewall. The worker needs outbound access to the target; the API does ' +
         'not, so testing from the API host proves nothing.'],
        ['<code>http_status_mismatch</code>',
         '<strong>Two causes share this reason.</strong> The message distinguishes them: ' +
         '&ldquo;Unexpected HTTP status N (expected ...)&rdquo;, or &ldquo;Response body did not ' +
         'contain the expected content&rdquo;. The second is a stale ' +
         '<code>expected_body_substring</code> more often than a real fault.'],
        ['<code>cert_expired</code>',
         'A verifying HTTPS check fails hard on an expired certificate <em>even if the server ' +
         'answered</em>. That is intentional.'],
        ['<code>tls_error</code> / <code>cert_invalid</code>',
         'An internal CA the container does not trust is the usual cause. Either add the CA to the ' +
         'image&rsquo;s trust store, or set <code>verify_ssl: false</code> on that endpoint and ' +
         'accept that <code>chain_verified</code> becomes unknown.'],
        ['<code>blocked_target</code>',
         'The resolved address is loopback, link-local, multicast, reserved or unspecified. The ' +
         'message names which. Private RFC1918 space is always allowed; set ' +
         '<code>ALLOW_LOOPBACK_TARGETS=true</code> only if you genuinely need to monitor something ' +
         'on the container itself.'],
        ['<code>config_error</code>',
         'Most often &ldquo;Stored credentials could not be decrypted; re-enter the endpoint ' +
         'authentication settings&rdquo; &mdash; see the encryption section below.'],
        ['<code>slow_response</code>',
         'Not a failure. The endpoint answered correctly but above its latency threshold, so it is ' +
         '<em>degraded</em> and still counts as up for uptime.']
      ]) +
      DOCS.callout('tip', 'Reproduce it without touching the data',
        '<p><code>POST /api/endpoints/{id}/check?persist=false</code> runs the identical probe and ' +
        'returns the outcome without writing anything. Then <code>POST ' +
        '/api/endpoints/{id}/diagnose</code> for a layered breakdown that tells you which stage is ' +
        'actually broken.</p>')),

    DOCS.details('It is down from InfraSight but up from everywhere else',
      `<p>That is exactly what vantage points are for. Configure <code>VANTAGE_POINTS</code> and the
      worker will re-check through each proxy on the failure that would open the incident. If the
      endpoint answers elsewhere, the incident is withheld and the reason is stored on the endpoint
      (<code>last_vantage_check</code>), with <code>incident_withheld</code> in the log.</p>
      <p>Remember the limit: on a single VM the worker, the kernel, the NIC and the availability zone
      are still shared. A vantage rules out the egress path and the transit beyond it. It does not
      rule out the host.</p>`),

    DOCS.details('An endpoint 404s but the service is healthy',
      `<p>The configured path probably does not exist. With <code>health_path_discovery</code> on
      (the default), a 404, 405, 410 or 501 triggers a search through
      <code>health_path_candidates</code>, and the first path that answers correctly is adopted and
      remembered.</p>
      <p>Check the endpoint detail view: the paths tried and what each returned are recorded, and the
      log shows <code>health_path_discovered</code> then <code>health_path_adopted</code>. If nothing
      answered, the original failure is kept &mdash; &ldquo;we could not find a health
      endpoint&rdquo; is not evidence that the service is healthy.</p>`),

    `<h2>Alerts</h2>`,

    DOCS.details('No alert was sent for an outage',
      `<p>Check each gate in order &mdash; the first one that applies is the answer.</p>` +
      DOCS.table(['Gate', 'Check'], [
        ['Did an incident even open?',
         '<code>consecutive_failures</code> must reach the resolved <code>failure_threshold</code>. ' +
         'Below it, failures are recorded but nobody is paged.'],
        ['Was the incident withheld?',
         'Look for <code>incident_withheld</code> in the worker log, and ' +
         '<code>last_vantage_check</code> on the endpoint.'],
        ['<code>alerts_enabled</code> globally?', 'Settings &rarr; Alerting.'],
        ['<code>alerts_enabled</code> on the endpoint?', 'Its own mute switch.'],
        ['Cooldown?',
         '<code>alert_suppressed_by_cooldown</code> is logged at <strong>debug</strong> level, so ' +
         'set <code>LOG_LEVEL=DEBUG</code> to see it. Recovery alerts are exempt from the cooldown.'],
        ['<code>notifications_enabled</code>?',
         'When off, the alert row exists with <code>notification_status: "skipped"</code>.'],
        ['Did any channel match?',
         'Severity, event type, environment and tag filters all have to pass. No match also produces ' +
         '<code>"skipped"</code>.']
      ])),

    DOCS.details('Alerts are recorded but delivery fails',
      `<p>The alert row carries the answer: <code>notification_status</code> is
      <code>failed</code> or <code>partial</code>, and <code>notification_error</code> holds the
      first failure. The channel row also accumulates <code>failure_count</code> and
      <code>last_error</code>.</p>` +
      DOCS.table(['Error', 'Means'], [
        ['<code>webhook responded 4xx/5xx: ...</code>',
         'The receiver rejected it. The first 200 characters of its body are included.'],
        ['<code>channel configuration could not be decrypted - it must be re-entered after an ' +
         'encryption key change</code>',
         '<code>ENCRYPTION_KEY</code> or <code>JWT_SECRET</code> changed. Re-enter the channel ' +
         'configuration.'],
        ['<code>no handler for channel type \'...\'</code>',
         'A channel row with a type the code does not implement. Effectively impossible through the ' +
         'API.']
      ]) +
      `<p>Use <code>POST /api/notification-channels/{id}/test</code> to verify a channel without
      waiting for a real outage. Delivery is attempted three times with exponential backoff before it
      is recorded as failed.</p>`),

    `<h2>Certificates</h2>`,

    DOCS.details('SSL status shows "unable_to_check"',
      `<p>No certificate could be read. Either no fingerprint was obtained &mdash; so nothing was
      written to <code>ssl_certificates</code> and only the endpoint&rsquo;s summary status was
      updated &mdash; or <code>days_remaining</code> could not be computed.</p>
      <p>Common causes: the endpoint is not HTTPS (in which case the status should be
      <code>not_applicable</code> instead &mdash; check <code>ssl_monitoring_enabled</code> and the
      protocol), the TLS handshake fails before a certificate is presented, or the host requires SNI
      the checker cannot satisfy. Run Diagnose: the TLS stage reports what the handshake actually
      did.</p>`),

    DOCS.details('Certificate days remaining looks stale',
      `<p>It is recomputed by the hourly SSL sweep, not only on a check. If it is wrong by more than
      an hour, check the worker log for <code>ssl_sweep_error</code>, and confirm the worker is
      running at all &mdash; the sweep is one of its five tasks.</p>
      <p>After changing <code>ssl_warning_days</code> or <code>ssl_critical_days</code>, the next
      sweep re-grades every current certificate and logs
      <code>certificates_regraded</code>. You do not have to wait for each endpoint to be checked
      again.</p>`),

    `<h2>Sign-in</h2>`,

    DOCS.details('Locked out, or rate limited',
      DOCS.table(['Response', 'Which throttle', 'Clear it with'], [
        ['<code>429</code> &ldquo;Too many sign-in attempts. Try again in N seconds.&rdquo;',
         'The rate limiter, keyed on the source address and the username',
         '<code>POST /api/users/{id}/reset-lockout</code> as an administrator, or wait out the ' +
         'window'],
        ['<code>423</code> with a lockout message',
         'The account lockout on the user row',
         'The same route &mdash; it clears <strong>both</strong> throttles, which is why clearing one ' +
         'was never enough']
      ]) +
      `<p>Both events are in the audit log as <code>login_failed</code> with
      <code>status</code> of <code>rate_limited</code> or <code>locked</code>.</p>`),

    DOCS.details('Everyone was signed out after a restart',
      `<p><code>JWT_SECRET</code> changed. If it is unset, a random value is generated at import as a
      last resort so a dev container still boots &mdash; which makes every token invalid on every
      restart, intentionally and loudly.</p>
      <p>Set <code>JWT_SECRET</code> to a fixed value of at least 32 characters. In production a
      shorter one logs <code>weak_jwt_secret</code> at startup.</p>`),

    DOCS.details('Stuck on the password-change screen',
      `<p>Expected while <code>must_change_password</code> is set: every route except
      <code>/api/auth/me</code>, <code>/api/auth/change-password</code> and
      <code>/api/auth/logout</code> answers 403 with
      <code>X-Password-Change-Required: true</code>. Completing the change returns a fresh token pair
      and clears the flag.</p>
      <p>If the new password is rejected with a 422, it failed the policy: at least
      <code>PASSWORD_MIN_LENGTH</code> characters, at most 72 bytes, with an uppercase letter, a
      lowercase letter, a digit and a special character.</p>`),

    DOCS.details('401 immediately after a role change',
      `<p>Working as designed. Changing a role or resetting a password bumps
      <code>token_version</code>, and every token carrying the old value fails with &ldquo;Session is
      no longer valid. Please sign in again.&rdquo; Sign in again to get a token with the new
      claims.</p>`),

    `<h2>Encryption</h2>`,

    DOCS.details('Every authenticated endpoint suddenly fails with config_error',
      DOCS.callout('danger', 'The encryption key changed',
        '<p>The worker logs <code>endpoint_credential_undecryptable</code> with the endpoint name ' +
        'and id, and records &ldquo;Stored credentials could not be decrypted; re-enter the endpoint ' +
        'authentication settings&rdquo;.</p>') +
      `<p>The cause is always the same: <code>ENCRYPTION_KEY</code> changed, or it was never set and
      <code>JWT_SECRET</code> changed (in which case the key was being derived from it).</p>
      <p>There is no recovery path &mdash; that is what encryption at rest means. Either restore the
      previous key material, or re-enter <code>auth_secret</code> on every affected endpoint and the
      configuration on every notification channel. Setting <code>ENCRYPTION_KEY</code> explicitly is
      what prevents a future <code>JWT_SECRET</code> rotation from doing this again.</p>`),

    `<h2>Performance</h2>`,

    DOCS.details('The dashboard is slow to load',
      `<p>It is roughly twenty aggregate queries over one window, already split into five concurrent
      branches. When it is slow, the cause is usually the volume of
      <code>monitoring_results</code>.</p>` +
      DOCS.code(`# How big is the history?
curl -s -H "Authorization: Bearer $TOKEN" \\
  http://localhost:8080/api/system/resources | jq '.database'

# Anything slower than a second is already logged by Postgres
docker compose logs postgres | grep 'duration:'`, 'shell') +
      DOCS.table(['Lever', 'Effect'], [
        ['Lower <code>data_retention_days</code>',
         'Fewer rows to aggregate. The next sweep applies it in batches.'],
        ['Use a shorter window',
         '<code>24h</code> scans far less than <code>90d</code>.'],
        ['Raise intervals on non-production endpoints',
         'Fewer rows written in the first place. This is what the five-minute default cadence is ' +
         'for.'],
        ['Check the indexes exist',
         '<code>ix_monitoring_results_endpoint_time</code> and ' +
         '<code>ix_monitoring_results_checked_at</code> are what make these queries viable.']
      ])),

    DOCS.details('The worker is not keeping up',
      `<p>Symptom: the due count climbs and <code>next_check_at</code> falls behind.</p>` +
      DOCS.table(['Lever', 'When to reach for it'], [
        ['Raise <code>WORKER_CONCURRENCY</code>',
         'First. The loop is I/O-bound, so 50 is conservative for most fleets. Watch the database ' +
         'pool: each in-flight check holds a connection.'],
        ['Raise <code>WORKER_BATCH_SIZE</code>',
         'Only alongside concurrency &mdash; the effective claim is ' +
         '<code>min(batch, concurrency * 4)</code>.'],
        ['Add worker replicas',
         '<code>docker compose up -d --scale worker=3</code>. No coordination needed.'],
        ['Raise intervals',
         'Often the real answer. A five-minute cadence on non-production halves the load against a ' +
         'one-minute one many times over.']
      ]) +
      DOCS.callout('warn', 'Watch for connection exhaustion',
        '<p>Each worker pod holds <code>WORKER_DB_POOL_SIZE + WORKER_DB_MAX_OVERFLOW</code> ' +
        'connections, each API pod its own pool. Postgres is started with ' +
        '<code>max_connections=200</code> in the bundled Compose file. Multiply before you ' +
        'scale.</p>')),

    DOCS.details('The worker container is using several gigabytes of memory',
      `<p>Almost certainly screenshots. Fifty concurrent HTTP checks is nothing; fifty concurrent
      Chromium pages is several gigabytes, which is why <code>SCREENSHOT_CONCURRENCY</code> defaults
      to 2 and is a separate knob from <code>WORKER_CONCURRENCY</code>.</p>
      <p>Set <code>SCREENSHOT_ENABLED=false</code> to switch rendering off fleet-wide without
      rebuilding the image, or turn <code>screenshot_enabled</code> off on the endpoints that do not
      need it. Response-body captures are unaffected &mdash; they cost a few kilobytes and no
      dependency.</p>`),

    `<h2>Docker</h2>`,

    DOCS.details('service "api" is not running',
      `<p>There is no <code>api</code> service. The container is called
      <strong><code>backend</code></strong>; <code>api</code> is the entrypoint <em>role</em> it runs
      with (<code>command: ["api"]</code>), and the two names sit close enough together in
      <code>docker-compose.yml</code> to be easy to conflate.</p>` +
      DOCS.code(`docker compose exec api alembic upgrade head       # fails
docker compose exec backend alembic upgrade head   # works`, 'shell') +
      DOCS.callout('tip', 'You almost certainly do not need to run this',
        '<p>The <code>api</code> role already runs <code>alembic upgrade head</code> and then ' +
        '<code>python -m app.bootstrap</code> on every start, before uvicorn. A plain ' +
        '<code>docker compose up -d --build</code> has therefore already migrated and seeded. ' +
        'To apply migrations as a deliberate separate step, use ' +
        '<code>docker compose run --rm backend migrate</code>.</p>')),

    DOCS.details('A container restarts repeatedly',
      DOCS.code(`docker compose ps                        # look at the STATUS column
docker compose logs --tail=200 <service>
docker inspect <container> --format '{{.State.Health.Status}}'`, 'shell') +
      DOCS.table(['Service', 'Most common cause'], [
        ['<code>backend</code>',
         'Migrations failing, or the database unreachable. The entrypoint exits non-zero, and the ' +
         '<code>unless-stopped</code> policy restarts it.'],
        ['<code>worker</code>',
         '<code>schema_not_ready</code> because the API never migrated. Fix the API.'],
        ['<code>postgres</code>',
         'A corrupt or mismatched data directory &mdash; often the wrong ' +
         '<code>COMPOSE_PROJECT_NAME</code> pointing at another cluster’s volume.'],
        ['<code>frontend</code>',
         'An nginx configuration error; the log says which line.']
      ])),

    DOCS.details('My data disappeared after an upgrade',
      DOCS.callout('danger', 'Check the volume name before anything else',
        '<p>The Postgres volume is named ' +
        '<code>&lt;COMPOSE_PROJECT_NAME&gt;_postgres_data</code>. Changing the project name points ' +
        'the stack at a different, empty volume while the old one sits untouched. Nothing was ' +
        'deleted.</p>') +
      DOCS.code(`docker volume ls | grep postgres_data`, 'shell') +
      `<p>If you see both <code>certmonitor_postgres_data</code> and
      <code>infrasight_postgres_data</code>, set <code>COMPOSE_PROJECT_NAME=certmonitor</code> in
      <code>.env</code> &mdash; and keep <code>POSTGRES_DB</code> and <code>POSTGRES_USER</code> as
      <code>certmonitor</code>, because those name the role and database that exist inside it.</p>`),

    DOCS.details('Image pull or build failures',
      DOCS.table(['Symptom', 'Cause'], [
        ['Build fails during <code>playwright install</code>',
         'No network access during build, or not enough disk. Chromium is about 400&nbsp;MB. The ' +
         'layer can be removed if screenshots are not wanted.'],
        ['Build fails compiling <code>psycopg2</code> or <code>cryptography</code>',
         'The builder stage installs <code>build-essential</code>, <code>libpq-dev</code>, ' +
         '<code>libffi-dev</code> and <code>libssl-dev</code> for exactly this. A failure here means ' +
         'the apt step did not complete &mdash; usually a proxy or DNS problem in the build ' +
         'environment.'],
        ['<code>npm ci</code> fails',
         'No <code>package-lock.json</code> falls back to <code>npm install</code> by design; a ' +
         'lockfile out of step with <code>package.json</code> does not.'],
        ['Pulling <code>dperson/torproxy:latest</code> fails',
         'Optional. Remove the three <code>tor-*</code> services and unset ' +
         '<code>VANTAGE_POINTS</code>.']
      ])),

    `<h2>Kubernetes</h2>`,

    DOCS.callout('note', 'No manifests ship with this repository',
      '<p>These are the failure modes the application&rsquo;s behaviour predicts, not ones observed ' +
      'in a shipped chart. See <a href="#/deployment-kubernetes">Deployment: Kubernetes</a>.</p>'),

    DOCS.details('CrashLoopBackOff',
      DOCS.table(['Pod', 'Likely cause'], [
        ['backend',
         'The same causes as the Compose container: database unreachable, migrations failing, ' +
         'configuration validation raising. <code>kubectl logs --previous</code> shows the ' +
         'entrypoint JSON.'],
        ['backend, killed by the liveness probe',
         '<strong>Check you are not probing <code>/health</code>.</strong> It returns 503 when the ' +
         'database is unreachable, so using it for liveness restarts every pod during a database ' +
         'blip. Use <code>/live</code>.'],
        ['worker',
         '<code>schema_not_ready</code>. The migration Job did not run, or did not complete before ' +
         'the worker started.'],
        ['Any pod, with <code>readOnlyRootFilesystem</code>',
         'Chromium needs somewhere to write. Mount an <code>emptyDir</code> at <code>/tmp</code>, or ' +
         'disable screenshots.']
      ])),

    DOCS.details('Pods are never Ready',
      `<p><code>/ready</code> returns 503 until the schema exists <em>and</em> has been seeded &mdash;
      it checks for a seeded role. <code>kubectl exec</code> into the pod and curl it:</p>` +
      DOCS.code(`curl -s localhost:8000/ready | jq`, 'shell') +
      DOCS.table(['<code>checks.detail</code>', 'Means'], [
        ['<code>database schema present but not seeded yet</code>',
         'Migrations ran, bootstrap did not. Run the <code>seed</code> entrypoint role.'],
        ['<code>database schema is missing - run migrations</code>',
         'The migration Job never ran.']
      ])),

    DOCS.details('Rate limits seem far too lenient with several API replicas',
      `<p>Redis is unreachable, so each pod is rate-limiting in its own memory. The effective limit
      is <code>LOGIN_RATE_LIMIT_ATTEMPTS</code> multiplied by the replica count.</p>
      <p>Look for <code>ratelimit_redis_unavailable</code> in the API log &mdash; it is logged once,
      with the reason, before falling back. The fallback is deliberately still enforced rather than
      disabled, but it is per-process.</p>
      <p>The same root cause makes import previews unreliable: the preview lives in one
      pod&rsquo;s memory, so the confirm request needs to reach that same pod.</p>`),

    `<h2>Reading the logs</h2>
    <p>Structured JSON in production (<code>LOG_FORMAT=json</code>), human-readable lines with
    <code>console</code>. Every request line carries <code>request_id</code>, <code>method</code>,
    <code>path</code>, <code>status_code</code>, <code>duration_ms</code>, <code>user</code> and
    <code>role</code>; probe paths are excluded so constant polling does not drown the signal.</p>`,

    DOCS.table(['Event', 'Severity', 'Means'], [
      ['<code>bootstrap_failed</code>', 'error', 'Seeding failed. <code>/ready</code> stays negative.'],
      ['<code>weak_jwt_secret</code>', 'warning', 'Under 32 characters in a production environment'],
      ['<code>default_admin_password_in_use</code>', 'warning', 'The bundled password was used'],
      ['<code>claim_failed</code>', 'error', 'The worker could not claim work'],
      ['<code>cycle_failed</code>', 'error', 'A whole worker cycle raised'],
      ['<code>check_cycle_error</code>', 'error', 'One endpoint’s check raised; its lease was released'],
      ['<code>heartbeat_write_failed</code>', 'warning', 'The worker could not write its heartbeat'],
      ['<code>retention_sweep_failed</code>', 'error', 'Cleanup failed; history will keep growing'],
      ['<code>endpoint_credential_undecryptable</code>', 'error', 'The encryption key changed'],
      ['<code>incident_withheld</code>', 'info', 'A vantage point could reach the endpoint'],
      ['<code>incident_open_race_resolved</code>', 'info',
       'Two workers raced; the unique index did its job'],
      ['<code>certificate_rotated</code>', 'info', 'A new fingerprint was observed'],
      ['<code>health_path_adopted</code>', 'info', 'A discovered path is now in use'],
      ['<code>authorisation_denied</code>', 'info', 'A permission check refused a request'],
      ['<code>notification_failed</code>', 'warning', 'A channel could not be delivered to'],
      ['<code>ratelimit_redis_unavailable</code>', 'warning',
       'Falling back to in-process rate limiting'],
      ['<code>request_failed</code>', 'error', 'An unhandled exception; the traceback is attached'],
      ['<code>database_error</code>', 'error', 'A SQLAlchemy error became a 503']
    ]),

    DOCS.callout('tip', 'Tracing one request end to end',
      '<p>Every response carries <code>X-Request-ID</code>, and the same id is bound to every log ' +
      'line that request produced. When a user reports a 500, the response body contains the id ' +
      'too &mdash; grep the logs for it rather than guessing at timestamps.</p>')

  ].join('\n')
});
