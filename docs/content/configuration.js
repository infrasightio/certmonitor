DOCS.page({
  id: 'configuration',
  title: 'Configuration reference',
  description: 'Every environment variable and every runtime setting, which layer wins, and what each one actually changes.',
  body: [

    `<h2>Two layers</h2>`,

    DOCS.diagram(`
  built-in default            in app/core/config.py or a SettingSpec
        |
        v
  environment variable        read ONCE at import time.
        |                     Changing it needs a restart.
        v
  system_settings row         editable from the Settings page.
        |                     Takes effect within the 10s settings cache.
        v
  effective value
`, 'Not every variable has a runtime counterpart. Where one exists, the database row wins - and the variable becomes the seed value used when the row is first created.'),

    DOCS.callout('warn', 'Environment variables are read once, at import',
      '<p><code>Settings</code> is instantiated at module import and cached with ' +
      '<code>@lru_cache</code>. Every variable on this page therefore requires a container restart ' +
      'to change. That is also why the test suite sets its environment <em>before</em> importing the ' +
      'application package.</p>'),

    `<h2>Environment variables</h2>

    <h3>Application</h3>`,

    DOCS.table(['Variable', 'Purpose', 'Required', 'Default / example', 'Used by'], [
      ['<code>APP_NAME</code>',
       'Declared but not referenced anywhere else in the code. The name shown in the UI comes from ' +
       'the <code>branding_app_name</code> setting instead.',
       'No', '<code>InfraSight</code>', '&mdash;'],
      ['<code>APP_VERSION</code>',
       'The running release. Reported by <code>/health</code>, OpenAPI and every worker heartbeat.',
       'No', '<code>1.0.0</code>', 'API, worker'],
      ['<code>APP_ENV</code>',
       'One of <code>development</code>, <code>testing</code>, <code>staging</code>, ' +
       '<code>production</code>. <code>staging</code> and <code>production</code> both count as ' +
       'production for HSTS and the weak-secret warning.',
       'No', '<code>production</code>', 'API'],
      ['<code>DEBUG</code>',
       'Declared but not referenced anywhere else. Use <code>LOG_LEVEL</code> and ' +
       '<code>DB_ECHO</code> for verbosity.',
       'No', '<code>false</code>', '&mdash;'],
      ['<code>LOG_LEVEL</code>', 'Python log level', 'No', '<code>INFO</code>', 'Both'],
      ['<code>LOG_FORMAT</code>',
       '<code>json</code> for shipping to Loki/ELK, <code>console</code> for humans', 'No',
       '<code>json</code>', 'Both'],
      ['<code>API_PREFIX</code>', 'Mount point for the API router', 'No', '<code>/api</code>', 'API'],
      ['<code>ROOT_PATH</code>', 'ASGI root path, for a proxy that strips a prefix', 'No',
       'empty', 'API'],
      ['<code>API_HOST</code>, <code>API_PORT</code>, <code>API_WORKERS</code>',
       'uvicorn bind address, port and process count', 'No',
       '<code>0.0.0.0</code>, <code>8000</code>, <code>2</code>', 'Entrypoint'],
      ['<code>CORS_ORIGINS</code>',
       'Comma-separated or JSON array. Empty means no cross-origin requests, which is correct when ' +
       'nginx serves the SPA and proxies <code>/api</code> on one origin.',
       'No', 'empty', 'API'],
      ['<code>ALLOWED_HOSTS</code>',
       'Comma-separated Host allow-list. Leave empty behind a reverse proxy; set it if the API is ' +
       'exposed directly.', 'No', 'empty', 'API'],
      ['<code>HTTP_PORT</code>', 'Host port the dashboard is published on', 'No',
       '<code>8080</code>', 'Compose'],
      ['<code>COMPOSE_PROJECT_NAME</code>',
       'Names the network, containers and &mdash; critically &mdash; the Postgres volume', 'No',
       '<code>infrasight</code>', 'Compose'],
      ['<code>IMAGE_TAG</code>', 'Tag applied to built images', 'No', '<code>latest</code>', 'Compose']
    ]),

    `<h3>Database</h3>`,

    DOCS.table(['Variable', 'Purpose', 'Required', 'Default / example', 'Used by'], [
      ['<code>DATABASE_URL</code>',
       'Async DSN. A plain <code>postgresql://</code> or <code>postgres://</code> value is rewritten ' +
       'to <code>postgresql+asyncpg://</code> automatically.',
       '<strong>Yes</strong> in any real deployment (Compose builds it from the parts below)',
       '<code>postgresql+asyncpg://infrasight:&lt;password&gt;@postgres:5432/infrasight</code>',
       'Both, and Alembic via the derived sync DSN'],
      ['<code>POSTGRES_DB</code>, <code>POSTGRES_USER</code>', 'Database and role names', 'No',
       '<code>infrasight</code>', 'Compose'],
      ['<code>POSTGRES_PASSWORD</code>',
       'Database password. <strong>Compose refuses to start without it.</strong>',
       '<strong>Yes</strong>', '&mdash; set your own', 'Compose'],
      ['<code>POSTGRES_PORT</code>', 'Host port, bound to <code>127.0.0.1</code> only', 'No',
       '<code>5432</code>', 'Compose'],
      ['<code>DB_POOL_SIZE</code>', 'Persistent pool connections per process', 'No',
       '<code>10</code>', 'Both'],
      ['<code>DB_MAX_OVERFLOW</code>', 'Additional burst connections', 'No', '<code>20</code>', 'Both'],
      ['<code>DB_POOL_TIMEOUT</code>', 'Seconds to wait for a connection', 'No', '<code>30</code>', 'Both'],
      ['<code>DB_POOL_RECYCLE</code>', 'Seconds before a connection is recycled', 'No',
       '<code>1800</code>', 'Both'],
      ['<code>DB_ECHO</code>', 'Log every SQL statement', 'No', '<code>false</code>', 'Both'],
      ['<code>WORKER_DB_POOL_SIZE</code>, <code>WORKER_DB_MAX_OVERFLOW</code>',
       'The worker container’s pool, set separately because it holds one short transaction per ' +
       'check rather than one per request',
       'No', '<code>10</code>, <code>10</code>', 'Compose'],
      ['<code>DB_WAIT_ATTEMPTS</code>, <code>DB_WAIT_DELAY</code>',
       'Entrypoint retry budget while waiting for the database', 'No',
       '<code>60</code>, <code>2</code>', 'Entrypoint'],
      ['<code>SCHEMA_WAIT_ATTEMPTS</code>, <code>SCHEMA_WAIT_DELAY</code>',
       'Entrypoint retry budget while the worker waits for the schema', 'No',
       '<code>90</code>, <code>2</code>', 'Entrypoint']
    ]),

    `<h3>Security</h3>`,

    DOCS.table(['Variable', 'Purpose', 'Required', 'Default / example', 'Used by'], [
      ['<code>JWT_SECRET</code>',
       'Signs every token, and seeds the encryption key when <code>ENCRYPTION_KEY</code> is unset. ' +
       'At least 32 random characters; a shorter one in production logs ' +
       '<code>weak_jwt_secret</code>. Changing it invalidates every session.',
       '<strong>Yes</strong> &mdash; a random value is generated as a last resort so a dev container ' +
       'still boots, which makes tokens invalid on every restart',
       '<code>openssl rand -hex 32</code>', 'Both'],
      ['<code>JWT_ALGORITHM</code>', 'Signing algorithm', 'No', '<code>HS256</code>', 'API'],
      ['<code>ACCESS_TOKEN_EXPIRE_MINUTES</code>',
       'Access token lifetime. Overridden at runtime by <code>session_timeout_minutes</code>.',
       'No', '<code>60</code>', 'API'],
      ['<code>REFRESH_TOKEN_EXPIRE_DAYS</code>',
       'Refresh token lifetime. Overridden by <code>session_refresh_days</code>.',
       'No', '<code>7</code>', 'API'],
      ['<code>ENCRYPTION_KEY</code>',
       'Encrypts endpoint credentials and channel configuration at rest. Derived from ' +
       '<code>JWT_SECRET</code> when blank.',
       'Strongly recommended', '&mdash; set your own', 'Both'],
      ['<code>PASSWORD_MIN_LENGTH</code>', 'Minimum password length', 'No', '<code>10</code>', 'API'],
      ['<code>LOGIN_RATE_LIMIT_ATTEMPTS</code>', 'Attempts per window, per address and per username',
       'No', '<code>5</code>', 'API'],
      ['<code>LOGIN_RATE_LIMIT_WINDOW_SECONDS</code>', 'Rate-limit window', 'No',
       '<code>300</code>', 'API'],
      ['<code>ACCOUNT_LOCKOUT_ATTEMPTS</code>',
       'Failures before lockout. Seeds <code>account_lockout_attempts</code>.', 'No',
       '<code>8</code>', 'API'],
      ['<code>ACCOUNT_LOCKOUT_MINUTES</code>', 'Lockout duration. Seeds the matching setting.', 'No',
       '<code>15</code>', 'API'],
      ['<code>SECURE_COOKIES</code>',
       'Declared but not referenced anywhere else. The application authenticates with bearer tokens ' +
       'in <code>localStorage</code> and sets no session cookie, so there is nothing for it to ' +
       'affect today.',
       'No', '<code>true</code>', '&mdash;'],
      ['<code>HSTS_ENABLED</code>',
       'Send <code>Strict-Transport-Security</code>. Applied only when <code>APP_ENV</code> is ' +
       'staging or production.', 'No', '<code>true</code>', 'API']
    ]),

    `<h3>Initial administrator</h3>`,

    DOCS.table(['Variable', 'Purpose', 'Required', 'Default / example', 'Used by'], [
      ['<code>ADMIN_USERNAME</code>', 'Username of the seeded account', 'No', '<code>admin</code>',
       'Bootstrap'],
      ['<code>ADMIN_PASSWORD</code>',
       'Its password. The bundled default is public knowledge, and using it logs ' +
       '<code>default_admin_password_in_use</code>.',
       '<strong>Yes</strong>, in practice', '&mdash; set your own', 'Bootstrap'],
      ['<code>ADMIN_EMAIL</code>', 'Its e-mail address', 'No', '<code>admin@localhost</code>',
       'Bootstrap'],
      ['<code>ADMIN_FORCE_PASSWORD_CHANGE</code>',
       'Force a password change at first sign-in. Keep this true.', 'No', '<code>true</code>',
       'Bootstrap']
    ]),

    DOCS.callout('note', 'Applied on first boot only',
      '<p><code>ensure_default_admin</code> never overwrites an existing account, so changing these ' +
      'after first boot has no effect. Reset a forgotten password through another ' +
      'administrator&rsquo;s <code>POST /api/users/{id}/reset-password</code>.</p>'),

    `<h3>Monitoring defaults</h3>
    <p>Every value here seeds a runtime setting of the same meaning; the Settings page is what changes
    behaviour afterwards.</p>`,

    DOCS.table(['Variable', 'Purpose', 'Required', 'Default', 'Used by'], [
      ['<code>DEFAULT_MONITOR_INTERVAL</code>',
       'Healthy cadence for an endpoint with no interval of its own. Note this is the <em>healthy</em> ' +
       'cadence only: a production endpoint runs at the fast interval, and a failing one at the ' +
       'failure interval.',
       'No', '<code>300</code>', 'Both'],
      ['<code>DEFAULT_TIMEOUT</code>',
       'Per-check timeout, and the basis of the worker’s lease length', 'No', '<code>10</code>',
       'Both'],
      ['<code>MIN_MONITOR_INTERVAL</code>',
       'Hard floor on any interval, enforced server-side so a mis-set value cannot turn the monitor ' +
       'into a load generator. Must be at least 10, or startup fails.',
       'No', '<code>30</code>', 'Both'],
      ['<code>MAX_MONITOR_INTERVAL</code>', 'Upper clamp on a configured interval', 'No',
       '<code>86400</code>', 'Both'],
      ['<code>SSL_WARNING_DAYS</code>', 'Days before expiry that a certificate is Expiring Soon', 'No',
       '<code>30</code>', 'Both'],
      ['<code>SSL_CRITICAL_DAYS</code>',
       'Days before expiry that it is Critical. Must be &le; the warning threshold, or startup fails.',
       'No', '<code>7</code>', 'Both'],
      ['<code>FAILURE_THRESHOLD</code>', 'Consecutive failures before an incident opens', 'No',
       '<code>3</code>', 'Both'],
      ['<code>RESPONSE_TIME_THRESHOLD_MS</code>', 'Above this, a successful check is degraded', 'No',
       '<code>2000</code>', 'Both'],
      ['<code>ALERT_COOLDOWN_MINUTES</code>', 'Suppresses repeat alerts of the same type', 'No',
       '<code>30</code>', 'Both'],
      ['<code>DATA_RETENTION_DAYS</code>', 'How long check results are kept', 'No', '<code>90</code>',
       'Worker'],
      ['<code>ALLOW_LOOPBACK_TARGETS</code>',
       'Permit probing loopback and link-local addresses. Private RFC1918 space is always allowed.',
       'No', '<code>false</code>', 'Both']
    ]),

    `<h3>Worker</h3>`,

    DOCS.table(['Variable', 'Purpose', 'Required', 'Default', 'Used by'], [
      ['<code>WORKER_ENABLED</code>',
       'False makes the process log <code>worker_disabled</code> and exit immediately', 'No',
       '<code>true</code>', 'Worker'],
      ['<code>WORKER_ID</code>',
       'Identity in the fleet view. <strong>Leave unset when scaling</strong> &mdash; the hostname ' +
       'or container ID is already unique per replica, and two workers sharing an id collapse into ' +
       'one heartbeat row.',
       'No', 'hostname', 'Worker'],
      ['<code>WORKER_CONCURRENCY</code>', 'Maximum simultaneous in-flight checks per process', 'No',
       '<code>50</code>', 'Worker'],
      ['<code>WORKER_POLL_INTERVAL_SECONDS</code>', 'Wait between cycles when nothing is due', 'No',
       '<code>5</code>', 'Worker'],
      ['<code>WORKER_BATCH_SIZE</code>',
       'Upper bound on a claim. The effective limit is ' +
       '<code>min(WORKER_BATCH_SIZE, concurrency * 4)</code>.',
       'No', '<code>200</code>', 'Worker'],
      ['<code>WORKER_HEARTBEAT_SECONDS</code>', 'Heartbeat cadence', 'No', '<code>15</code>', 'Worker'],
      ['<code>WORKER_STALE_AFTER_SECONDS</code>',
       'Beyond this without a heartbeat, <code>/health</code> reports the worker unhealthy', 'No',
       '<code>90</code>', 'Both'],
      ['<code>WORKER_RETIRE_AFTER_SECONDS</code>',
       'Beyond this, a heartbeat is treated as a retired worker: ignored by <code>/health</code> and ' +
       'pruned. Kept short because 30 minutes made every rebuild look degraded for half an hour.',
       'No', '<code>300</code>', 'Both'],
      ['<code>WORKER_REGION</code>',
       'Free-text label for where this worker runs. Descriptive only &mdash; nothing schedules by it.',
       'No', 'empty', 'Worker'],
      ['<code>RETENTION_SWEEP_INTERVAL_SECONDS</code>', 'Retention sweep cadence', 'No',
       '<code>3600</code>', 'Worker']
    ]),

    `<h3>Vantage points</h3>`,

    DOCS.table(['Variable', 'Purpose', 'Required', 'Default', 'Used by'], [
      ['<code>VANTAGE_POINTS</code>',
       'JSON array of <code>{name, proxy, country?}</code>. JSON rather than a settings row because ' +
       'proxy URLs may carry credentials, and those belong in the environment rather than in a row ' +
       'rendered in the UI. Empty turns the feature off entirely. A malformed value is logged once ' +
       'and ignored &mdash; a typo must not stop the monitor monitoring.',
       'No', 'empty (the bundled example points at the three tor services)', 'Worker'],
      ['<code>VANTAGE_ENABLED</code>', 'Master switch', 'No', '<code>true</code>', 'Worker'],
      ['<code>VANTAGE_TIMEOUT_SECONDS</code>',
       'Per-probe timeout. The whole confirmation round is capped at this plus 5 seconds.', 'No',
       '<code>15</code>', 'Worker'],
      ['<code>VANTAGE_CONCURRENCY</code>',
       'Confirmations in flight across the worker. Extra ones are <em>skipped</em>, not queued.',
       'No', '<code>3</code>', 'Worker'],
      ['<code>VANTAGE_ECHO_URL</code>',
       'Where to ask a proxy what its exit is. Any service returning JSON with an <code>ip</code> ' +
       'and a country field. <strong>The only outbound call to a third party in the system</strong> ' +
       '&mdash; blank it to stop asking anything external.',
       'No', '<code>https://ifconfig.co/json</code>', 'Worker'],
      ['<code>VANTAGE_STATUS_INTERVAL_SECONDS</code>', 'How often to re-observe the exits', 'No',
       '<code>900</code>', 'Worker']
    ]),

    `<h3>Captures and screenshots</h3>`,

    DOCS.table(['Variable', 'Purpose', 'Required', 'Default', 'Used by'], [
      ['<code>SCREENSHOT_ENABLED</code>',
       'Fleet-wide switch. Screenshots are additionally opt-in per endpoint. Response-body captures ' +
       'are always kept and are not affected by this.',
       'No', '<code>true</code>', 'Worker'],
      ['<code>SCREENSHOT_CONCURRENCY</code>',
       'Concurrent Chromium pages. Deliberately far below <code>WORKER_CONCURRENCY</code>.', 'No',
       '<code>2</code>', 'Worker'],
      ['<code>SCREENSHOT_TIMEOUT_SECONDS</code>', 'Hard cap on one render', 'No', '<code>20</code>',
       'Worker'],
      ['<code>SCREENSHOT_WIDTH</code>, <code>SCREENSHOT_HEIGHT</code>', 'Viewport', 'No',
       '<code>1280</code> x <code>800</code>', 'Worker'],
      ['<code>SCREENSHOT_QUALITY</code>',
       'JPEG quality. JPEG rather than PNG because at PNG fidelity two captures per endpoint is ' +
       'megabytes rather than kilobytes.',
       'No', '<code>70</code>', 'Worker'],
      ['<code>SCREENSHOT_USER_AGENT</code>', 'User agent used by the renderer', 'No',
       'a Chrome 120 string with <code>InfraSight/1.0</code> appended', 'Worker']
    ]),

    `<h3>Redis and imports</h3>`,

    DOCS.table(['Variable', 'Purpose', 'Required', 'Default', 'Used by'], [
      ['<code>REDIS_URL</code>',
       'Cross-replica login rate limits and import previews. The application degrades to in-process ' +
       'equivalents when it is unreachable &mdash; and the rate limit is still enforced, just ' +
       'per-process.',
       'No for one replica; effectively yes above one', '<code>redis://redis:6379/0</code>', 'API'],
      ['<code>MAX_IMPORT_ROWS</code>', 'Rows per import file', 'No', '<code>5000</code>', 'API'],
      ['<code>MAX_UPLOAD_BYTES</code>',
       'Upload size cap. nginx allows 12&nbsp;MB, so the API produces the error rather than the proxy.',
       'No', '<code>10485760</code> (10&nbsp;MB)', 'API']
    ]),

    `<h2>Runtime settings</h2>
    <p>Rows in <code>system_settings</code>, seeded from the specs on first boot and editable from the
    Settings page with <code>settings:write</code>. Changes take effect within the
    <strong>10-second</strong> in-process cache &mdash; no restart.</p>

    <p>Updates are validated as a batch: an unknown key, a value outside its bounds, or an SSL
    critical threshold above the warning threshold rejects the whole request, and nothing is
    written.</p>`,

    DOCS.tabs([
      {
        label: 'Monitoring',
        html: DOCS.table(['Setting', 'Type', 'Default', 'Effect'], [
          ['<code>default_monitor_interval</code>', 'int', '300',
           'Applied to new endpoints that do not specify their own'],
          ['<code>fast_check_environments</code>', 'json', '<code>["production"]</code>',
           'Endpoints in these are checked at the fast interval whether or not they are failing'],
          ['<code>fast_check_interval</code>', 'int', '60',
           'The cadence for those environments. A ceiling on staleness, never a slow-down.'],
          ['<code>failure_recheck_interval</code>', 'int', '60',
           'Cadence while an endpoint is failing, until it passes again'],
          ['<code>default_timeout</code>', 'int', '10', 'How long a check waits before failing'],
          ['<code>failure_threshold</code>', 'int', '3', 'Consecutive failures before an incident opens'],
          ['<code>response_time_threshold_ms</code>', 'int', '2000',
           'Slower successful responses are reported as degraded'],
          ['<code>recovery_threshold</code>', 'int', '1',
           'Consecutive successes before an incident closes. Raise it to guard against flapping.'],
          ['<code>incident_grouping_minutes</code>', 'int', '15',
           'Failures inside this window join the previous incident instead of opening a new one'],
          ['<code>health_path_discovery</code>', 'bool', 'true',
           'Try alternative health paths when the configured one is definitively absent'],
          ['<code>health_path_candidates</code>', 'json', '12 common paths',
           'Tried in order. An explicitly emptied list means do not probe.'],
          ['<code>check_retry_attempts</code>', 'int', '0',
           'Retries for a transport-level failure only. Off by default.'],
          ['<code>check_retry_delay_ms</code>', 'int', '500', 'Pause between attempts'],
          ['<code>allowed_intervals</code>', 'json', '30, 60, 300, 600, 1800, 3600',
           'Interval options offered in the endpoint form. Values below ' +
           '<code>MIN_MONITOR_INTERVAL</code> are filtered out at read time.'],
          ['<code>latency_anomaly_multiplier</code>', 'float', '3.0',
           'Diagnose: how far above its own baseline counts as a finding'],
          ['<code>intermittent_availability_threshold_pct</code>', 'float', '95.0',
           'Diagnose: below this, an endpoint that passes now is reported as intermittent'],
          ['<code>recovery_checks_required</code>', 'int', '3',
           'Diagnose: passing checks before it calls something resolved'],
          ['<code>deployment_correlation_minutes</code>', 'int', '30',
           'Diagnose: how close a deployment must be to be reported as correlated']
        ])
      },
      {
        label: 'SSL',
        html: DOCS.table(['Setting', 'Type', 'Default', 'Effect'], [
          ['<code>ssl_warning_days</code>', 'int', '30', 'Below this, Expiring Soon'],
          ['<code>ssl_critical_days</code>', 'int', '7',
           'Below this, Critical. Must be &le; the warning threshold.']
        ]) +
        `<p>Editing either triggers the hourly sweep to re-grade every current certificate, so the
        change is reflected without waiting for each endpoint to be checked again.</p>`
      },
      {
        label: 'Alerting',
        html: DOCS.table(['Setting', 'Type', 'Default', 'Effect'], [
          ['<code>alerts_enabled</code>', 'bool', 'true',
           'Master switch for alert generation <em>and</em> delivery'],
          ['<code>alert_on_degraded</code>', 'bool', 'true',
           'Raise an alert when a healthy endpoint breaches its latency threshold'],
          ['<code>notifications_enabled</code>', 'bool', 'true',
           'When off, alerts are still recorded but nothing is dispatched'],
          ['<code>alert_cooldown_minutes</code>', 'int', '30',
           'Suppresses repeat alerts of the same type for the same endpoint. Recovery alerts are ' +
           'exempt.']
        ])
      },
      {
        label: 'Retention',
        html: DOCS.table(['Setting', 'Type', 'Default', 'Deletes'], [
          ['<code>data_retention_days</code>', 'int', '90',
           'Check results, and superseded certificate observations'],
          ['<code>alert_retention_days</code>', 'int', '180', 'Alerts'],
          ['<code>incident_retention_days</code>', 'int', '730', 'Resolved incidents only'],
          ['<code>audit_retention_days</code>', 'int', '365', 'Audit entries']
        ])
      },
      {
        label: 'Security',
        html: DOCS.table(['Setting', 'Type', 'Default', 'Effect'], [
          ['<code>session_timeout_minutes</code>', 'int', '60',
           'Access-token lifetime for <em>new</em> sessions. Cannot shorten a token already issued.'],
          ['<code>session_refresh_days</code>', 'int', '7',
           'How long a browser can silently renew without the password'],
          ['<code>account_lockout_attempts</code>', 'int', '8', 'Failures before an account locks'],
          ['<code>account_lockout_minutes</code>', 'int', '15',
           'How long it stays locked if nobody clears it']
        ])
      },
      {
        label: 'Changes and RCA',
        html: DOCS.table(['Setting', 'Type', 'Default', 'Effect'], [
          ['<code>change_approval_environments</code>', 'json', '<code>["production"]</code>',
           'A change targeting one of these must be approved; others can be deployed straight from ' +
           'draft'],
          ['<code>change_health_check_on_resume</code>', 'bool', 'true',
           'Check the affected endpoints immediately when monitoring resumes'],
          ['<code>change_max_pause_minutes</code>', 'int', '240',
           'Past this, an active deployment is flagged as overrunning'],
          ['<code>rca_reminder_days</code>', 'int', '7',
           'An open RCA older than this is highlighted. Nothing escalates.'],
          ['<code>rca_default_due_days</code>', 'int', '0',
           'Applied when an RCA is requested without a due date. Zero means no deadline &mdash; and ' +
           'an RCA without one is never overdue.']
        ])
      },
      {
        label: 'General and features',
        html: DOCS.table(['Setting', 'Type', 'Default', 'Effect'], [
          ['<code>public_base_url</code>', 'string', 'empty',
           'Where operators reach InfraSight in a browser. When set, Slack alerts carry an ' +
           '<em>Open in InfraSight</em> button linking to the endpoint; when empty they carry no ' +
           'link, because a wrong link is worse than none. Must be an absolute http(s) URL &mdash; ' +
           'a trailing slash is stripped and anything else is rejected.'],
          ['<code>uptime_sla_target</code>', 'float', '99.9',
           'The line the dashboard compares uptime against, and what <code>sla_breaches</code> is ' +
           'measured from'],
          ['<code>branding_app_name</code>', 'string', '<code>InfraSight</code>',
           'Shown in the header, on the sign-in screen and in the browser tab. Capped at 40 ' +
           'characters, because it is served unauthenticated and a 400-character name would break ' +
           'the header for everyone.'],
          ['<code>feature_change_management_enabled</code>', 'bool', 'true',
           'Off hides the module <em>and</em> makes its API answer 403'],
          ['<code>feature_rca_enabled</code>', 'bool', 'true',
           'Off hides RCA; incident history itself is unaffected']
        ]) +
        DOCS.callout('note', 'Both features default to on',
          '<p>Defaulting either to off would hide a module an existing deployment already uses. A new ' +
          'deployment turns off what it does not want.</p>')
      }
    ]),

    `<h2>Validation at startup</h2>
    <p>Two cross-field rules are checked when <code>Settings</code> is constructed. They raise, so the
    container fails to start rather than running with an incoherent configuration:</p>

    <ul>
      <li><code>MIN_MONITOR_INTERVAL</code> must be at least 10 seconds.</li>
      <li><code>SSL_CRITICAL_DAYS</code> must be no greater than <code>SSL_WARNING_DAYS</code>.</li>
    </ul>

    <p>One rule is corrected silently rather than raising: a <code>DEFAULT_MONITOR_INTERVAL</code>
    below <code>MIN_MONITOR_INTERVAL</code> is raised to the minimum.</p>`,

    DOCS.callout('danger', 'Never commit .env',
      '<p><code>.env.example</code> contains no real secrets and is safe to commit. ' +
      '<code>.env</code> carries the database password, the JWT secret, the encryption key and the ' +
      'initial administrator password, and is excluded by <code>.gitignore</code>. Generate strong ' +
      'values with <code>openssl rand -hex 32</code>.</p>')

  ].join('\n')
});
