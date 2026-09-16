DOCS.page({
  id: 'api',
  title: 'API reference',
  description: 'Every route the application exposes, with its permission, parameters and responses. Extracted from the route modules.',
  body: [

    `<h2>Conventions</h2>`,

    DOCS.table(['Aspect', 'Rule'], [
      ['Base path', '<code>/api</code> (<code>API_PREFIX</code>). ' +
       '<code>/health</code>, <code>/ready</code>, <code>/live</code> and <code>/branding</code> are ' +
       'root-mounted.'],
      ['Authentication',
       '<code>Authorization: Bearer &lt;access_token&gt;</code> on every route except the four ' +
       'above, <code>POST /api/auth/login</code>, <code>POST /api/auth/refresh</code>, ' +
       '<code>GET /api/auth/password-policy</code> and ' +
       '<code>GET /api/settings/alert-options</code>.'],
      ['Content type', '<code>application/json</code>, except the two multipart upload routes and ' +
       'the file-download routes.'],
      ['Pagination', '<code>?page=</code> (from 1) and <code>?page_size=</code> (1&ndash;200, ' +
       'default 25; the user list defaults to 50). Every list route returns the same shape: ' +
       '<code>{items: [...], meta: {total, page, page_size, pages, has_next, has_previous}}</code>.'],
      ['Repeatable filters', 'Both <code>?status=up&amp;status=down</code> and ' +
       '<code>?status=up,down</code> are accepted.'],
      ['Errors', 'Always <code>{detail}</code>, usually with <code>code</code>, and with ' +
       '<code>fields</code> on a 422. Every response carries <code>X-Request-ID</code>.'],
      ['Interactive docs',
       '<code>/api/docs</code> (Swagger UI), <code>/api/redoc</code>, ' +
       '<code>/api/openapi.json</code>. Generated from the same route definitions, so it is never ' +
       'out of date.']
    ]),

    `<h3>Common status codes</h3>`,

    DOCS.table(['Code', 'Meaning here'], [
      ['<code>400</code>', 'A domain rule was violated &mdash; an invalid URL, a bad workflow ' +
       'transition. The <code>detail</code> is written to be shown to a user.'],
      ['<code>401</code>', 'Missing, invalid or expired token; or a <code>tv</code> mismatch, ' +
       'meaning the session was invalidated server-side.'],
      ['<code>403</code>', 'Three distinct causes: the role lacks the permission; the password must ' +
       'be changed first (carries <code>X-Password-Change-Required: true</code>); or the module is ' +
       'disabled for this deployment.'],
      ['<code>404</code>', 'No such resource.'],
      ['<code>409</code>', 'A conflict &mdash; a duplicate name or URL, or a concurrent edit.'],
      ['<code>413</code>', 'Upload above <code>MAX_UPLOAD_BYTES</code>.'],
      ['<code>422</code>', 'Schema validation failed. <code>fields</code> maps each field to its ' +
       'message.'],
      ['<code>423</code>', 'The account is locked out.'],
      ['<code>429</code>', 'Login rate limit. Carries <code>Retry-After</code>.'],
      ['<code>503</code>', 'A database error, or the instance is not ready.']
    ]),

    `<h2>Health and probes</h2>`,

    DOCS.endpoint({ method: 'GET', path: '/health', auth: false,
      summary: 'Overall health. 200 when servable, 503 when the database is unreachable.',
      body:
        `<p>A stale worker degrades the response to <code>degraded</code> but keeps it at 200: the API
        can still serve the dashboard and accept configuration changes.</p>` +
        DOCS.code(`{
  "status": "healthy",
  "version": "1.0.0",
  "environment": "production",
  "uptime_seconds": 3821.44,
  "database": "healthy",
  "monitoring_worker": "healthy",
  "components": {
    "database": {"status": "healthy", "latency_ms": 1.87},
    "monitoring_worker": {"status": "healthy", "detail": "1 worker(s) reporting"}
  },
  "checked_at": "2026-09-16T09:14:02.117Z"
}`, '200 response') }),

    DOCS.endpoint({ method: 'GET', path: '/ready', auth: false,
      summary: 'Readiness. 503 until the schema exists and has been seeded.',
      body: DOCS.code(`{"status": "ready", "checks": {"database": "healthy", "schema": "healthy"},
 "checked_at": "2026-09-16T09:14:02.117Z"}`, '200 response') +
        `<p>When the schema is present but unseeded, <code>checks.detail</code> reads &ldquo;database
        schema present but not seeded yet&rdquo;; when it is missing entirely, &ldquo;database schema
        is missing - run migrations&rdquo;.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/live', auth: false,
      summary: 'Process liveness. Touches no dependency.',
      body: DOCS.code(`{"status": "alive", "uptime_seconds": 3821.44}`, '200 response') +
        `<p>Use this for a Kubernetes liveness probe &mdash; never <code>/health</code>, or a database
        blip restarts every pod.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/branding', auth: false,
      summary: 'Deployment name and logo URL, read by the sign-in screen.',
      body: DOCS.code(`{"app_name": "InfraSight", "logo_url": "/branding/logo?v=<etag>"}`, '200 response') +
        `<p>Never fails: a branding lookup must not be what stops the sign-in page rendering, so any
        error falls back to the built-in name.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/branding/logo', auth: false,
      summary: 'The uploaded logo bytes. 404 when none has been uploaded.',
      body: `<p>Answers 304 to a matching <code>If-None-Match</code>. Served with a one-year immutable
      <code>Cache-Control</code> (the URL carries the content hash, so a new upload is a new URL),
      <code>nosniff</code>, and a locked-down CSP so it stays inert if opened directly.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/api/workers', permission: 'settings:read',
      summary: 'Per-worker heartbeat detail.',
      body: DOCS.code(`[{
  "worker_id": "a3f19c02b7d1", "hostname": "a3f19c02b7d1",
  "region": "ap-south-1b", "version": "1.0.0",
  "started_at": "...", "last_seen_at": "...",
  "seconds_since_heartbeat": 4.2, "is_healthy": true,
  "checks_completed": 18422, "checks_failed": 96, "in_flight": 3
}]`, '200 response') }),

    DOCS.endpoint({ method: 'GET', path: '/api/system/resources', permission: 'settings:read',
      summary: 'Disk, database, and CPU/memory for the services that report it.',
      body: `<p>Includes a <code>not_measured</code> list naming what cannot be measured without the
      Docker socket, rather than leaving those figures blank.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/api/vantage-points', permission: 'settings:read',
      summary: 'Every configured vantage point and its last observed exit.',
      body: `<p>Driven by the configuration rather than by observations, so a vantage that has never
      answered still appears.</p>` }),

    `<h2>Authentication</h2>`,

    DOCS.endpoint({ method: 'POST', path: '/api/auth/login', auth: false,
      summary: 'Exchange credentials for a token pair.',
      body:
        DOCS.code(`{"username": "admin", "password": "<password>"}`, 'request') +
        DOCS.code(`{
  "access_token": "eyJhbGciOi...",
  "refresh_token": "eyJhbGciOi...",
  "expires_in": 3600,
  "expires_at": "2026-09-16T10:14:02Z",
  "must_change_password": false,
  "user": {
    "id": "0f2f...", "username": "admin", "email": "admin@localhost",
    "full_name": null, "role": "admin",
    "permissions": ["alert:read", "alert:write", "audit:read", "..."],
    "is_active": true, "must_change_password": false,
    "last_login_at": "2026-09-16T09:14:02Z"
  }
}`, '200 response') +
        DOCS.table(['Code', 'When'], [
          ['<code>401</code>', 'Wrong username <em>or</em> wrong password &mdash; the same response ' +
           'either way'],
          ['<code>403</code>', 'The account is disabled'],
          ['<code>423</code>', 'Locked out after <code>account_lockout_attempts</code> failures'],
          ['<code>429</code>', 'Rate limited by address or username; carries <code>Retry-After</code>']
        ]) }),

    DOCS.endpoint({ method: 'POST', path: '/api/auth/refresh', auth: false,
      summary: 'Exchange a refresh token for a new pair.',
      body: DOCS.code(`{"refresh_token": "eyJhbGciOi..."}`, 'request') +
        `<p>Returns the same shape as login. 401 when the token is invalid, expired, the user is gone
        or inactive, or the <code>tv</code> claim no longer matches.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/api/auth/me',
      summary: 'The signed-in user, with their permission list.',
      body: `<p>Reachable while <code>must_change_password</code> is set. The SPA calls this on every
      load to re-validate a stored token &mdash; it may have expired, or the role may have changed
      since it was issued.</p>` }),

    DOCS.endpoint({ method: 'POST', path: '/api/auth/change-password',
      summary: 'Change your own password. Returns a fresh token pair.',
      body: DOCS.code(`{"current_password": "<old>", "new_password": "<new>"}`, 'request') +
        `<p>Deliberately reachable while <code>must_change_password</code> is set &mdash; it is the
        only way out of that state. The change bumps <code>token_version</code>, invalidating the
        caller&rsquo;s current tokens, which is why a new pair is returned. 400 when the current
        password is wrong; 422 when the new one fails the policy.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/api/auth/password-policy', auth: false,
      summary: 'Minimum length, for client-side validation.' }),

    DOCS.endpoint({ method: 'POST', path: '/api/auth/logout',
      summary: 'Record the sign-out.',
      body: `<p>Access tokens are stateless and short-lived, so the client discards them. To force
      immediate invalidation everywhere, reset the user&rsquo;s password.</p>` }),

    `<h2>Endpoints</h2>`,

    DOCS.endpoint({ method: 'GET', path: '/api/endpoints', permission: 'endpoint:read',
      summary: 'List with search, filtering, sorting and pagination.',
      body: DOCS.table(['Parameter', 'Accepts'], [
        ['<code>search</code>', 'Matches name, URL, hostname, description, owner or team'],
        ['<code>environment</code>, <code>tag</code>', 'UUIDs, repeatable'],
        ['<code>status</code>', '<code>up</code>, <code>down</code>, <code>degraded</code>, ' +
         '<code>unknown</code>, <code>paused</code>'],
        ['<code>ssl_status</code>', 'Any certificate state'],
        ['<code>owner</code>, <code>team</code>, <code>application</code>', 'Exact values'],
        ['<code>check_type</code>, <code>protocol</code>', 'Exact values'],
        ['<code>monitoring_enabled</code>', 'Boolean'],
        ['<code>ssl_expiring_within_days</code>', '0&ndash;3650'],
        ['<code>sort_by</code>, <code>sort_dir</code>',
         'Sortable fields come from <code>/endpoints/filters</code>; direction is ' +
         '<code>asc</code> or <code>desc</code>'],
        ['<code>include_uptime</code>',
         'Default true. Adds 24h uptime per row at the cost of one extra query.']
      ]) +
      `<p>Each row carries <code>effective_interval_seconds</code> &mdash; the cadence actually in
      force, which may be shorter than the configured one.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/api/endpoints/filters', permission: 'endpoint:read',
      summary: 'Every available filter value and the sortable fields.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/endpoints/summary', permission: 'endpoint:read',
      summary: 'Status counts for the header chips.' }),

    DOCS.endpoint({ method: 'POST', path: '/api/endpoints', permission: 'endpoint:write',
      summary: 'Create an endpoint. 201 on success.',
      body:
        DOCS.code(`{
  "name": "Payments API health",
  "url": "https://payments.internal.example/health",
  "check_type": "http",
  "http_method": "GET",
  "environment": "production",
  "tags": ["backend", "critical"],
  "team": "platform",
  "application": "payments",
  "owner": "platform@example.com",
  "owner_name": "Platform Engineering",
  "interval_seconds": 60,
  "timeout_seconds": 10,
  "expected_status_codes": "200,204",
  "expected_body_substring": "\\"status\\":\\"ok\\"",
  "follow_redirects": true,
  "verify_ssl": true,
  "ssl_monitoring_enabled": true,
  "auth_type": "bearer",
  "auth_secret": "<token>",
  "failure_threshold": 3,
  "response_time_threshold_ms": 1500,
  "alerts_enabled": true
}`, 'request') +
        `<p>409 on a duplicate; 400 on an unusable URL. The response never contains
        <code>auth_secret</code> &mdash; only <code>auth_secret_hint</code>, a mask.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/api/endpoints/{id}', permission: 'endpoint:read',
      summary: 'Full detail, including 24h uptime and whether an incident is open.' }),

    DOCS.endpoint({ method: 'PUT', path: '/api/endpoints/{id}', permission: 'endpoint:write',
      summary: 'Partial update. Omitted fields are left untouched.',
      body: `<p>Omitting <code>auth_secret</code> keeps the stored credential; sending
      <code>auth_type: "none"</code> clears it.</p>` }),

    DOCS.endpoint({ method: 'PATCH', path: '/api/endpoints/{id}/monitoring', permission: 'endpoint:write',
      summary: 'Enable, disable, pause or resume.',
      body: DOCS.code(`{"is_paused": true, "pause_reason": "Vendor maintenance window"}`, 'request') +
        `<p>Resuming schedules the endpoint immediately, clears any stale lease, and clears both
        <code>pause_reason</code> and <code>paused_by_change_id</code>. Pausing manually also clears
        <code>paused_by_change_id</code>, so a later deployment completion cannot resume it behind
        the operator.</p>` }),

    DOCS.endpoint({ method: 'DELETE', path: '/api/endpoints/{id}', permission: 'endpoint:delete',
      summary: 'Delete the endpoint and its monitoring history.',
      body: `<p>Results, certificates, incidents and captures cascade with it. The audit entry remains
      as the record that it existed.</p>` }),

    DOCS.endpoint({ method: 'POST', path: '/api/endpoints/{id}/check', permission: 'endpoint:check',
      summary: 'Run a check immediately.',
      body: `<p><code>?persist=false</code> runs a real probe and returns the outcome without writing
      anything &mdash; a configuration dry run. With <code>persist=true</code> (the default) the
      result is recorded as <code>is_manual</code>, status transitions apply, and the next check is
      rescheduled.</p>` }),

    DOCS.endpoint({ method: 'POST', path: '/api/endpoints/{id}/diagnose', permission: 'endpoint:check',
      summary: 'Full layered triage. Slow by design.',
      body: `<p><code>?focus=</code> one of <code>auto</code>, <code>endpoint</code>,
      <code>ssl</code>, <code>availability</code>, <code>performance</code>,
      <code>recent_failure</code>, <code>deployment_impact</code>. Writes nothing to the monitoring
      history; the conclusion is stored in <code>diagnoses</code>.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/api/endpoints/{id}/diagnoses', permission: 'endpoint:read',
      summary: 'Past diagnoses, newest first, paginated.' }),

    DOCS.endpoint({ method: 'POST', path: '/api/endpoints/{id}/diagnoses/{diagnosis_id}/resolution',
      permission: 'endpoint:write',
      summary: 'Record what actually fixed it.',
      body: DOCS.code(`{"resolution": "Restarted the upstream pool; connections were exhausted."}`, 'request') }),

    DOCS.endpoint({ method: 'GET', path: '/api/endpoints/{id}/history', permission: 'endpoint:read',
      summary: 'Paginated check results, newest first.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/endpoints/{id}/stats', permission: 'endpoint:read',
      summary: 'Availability, latency and incident counts for a window.',
      body: `<p><code>?window=</code> one of <code>24h</code>, <code>7d</code>, <code>30d</code>,
      <code>90d</code>. Includes uptime, p95, downtime seconds and incident count.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/api/endpoints/{id}/network', permission: 'endpoint:read',
      summary: 'Every address the hostname resolves to, and what each one is.',
      body: `<p>Reverse DNS is best-effort with a hard 2-second cap, and a miss is reported as a miss.
      There is no geolocation and no third-party lookup.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/api/endpoints/{id}/ssl', permission: 'endpoint:read',
      summary: 'The current certificate.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/endpoints/{id}/ssl/history', permission: 'endpoint:read',
      summary: 'Every certificate observed for this endpoint, newest first.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/endpoints/{id}/captures', permission: 'endpoint:read',
      summary: 'The last successful and last failed response. At most two records.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/endpoints/{id}/captures/{outcome}/image',
      permission: 'endpoint:read',
      summary: 'The screenshot from one capture. outcome is success or failure.',
      body: `<p>Returns image bytes with an ETag, so a browser that already has this screenshot is not
      sent it again until it is replaced. The SPA fetches it as a blob rather than pointing an
      <code>&lt;img src&gt;</code> at it, because a plain <code>&lt;img&gt;</code> would omit the
      bearer header and render a broken image for a 401.</p>` }),

    DOCS.endpoint({ method: 'POST', path: '/api/endpoints/bulk', permission: 'endpoint:write',
      summary: 'Apply one action to many endpoints.',
      body: DOCS.code(`{
  "endpoint_ids": ["0f2f...", "7c81..."],
  "action": "pause",
  "pause_reason": "Datacentre maintenance",
  "tags": []
}`, 'request') +
        `<p>Actions: <code>enable</code>, <code>disable</code>, <code>pause</code>,
        <code>resume</code>, <code>delete</code>, <code>check</code>, <code>tag</code>,
        <code>untag</code>. <code>delete</code> additionally requires <code>endpoint:delete</code>
        and <code>check</code> requires <code>endpoint:check</code>, both checked inside the handler
        so the other actions stay available to any endpoint editor.</p>` }),

    `<h2>Dashboard and certificates</h2>`,

    DOCS.endpoint({ method: 'GET', path: '/api/dashboard', permission: 'endpoint:read',
      summary: 'Everything the dashboard renders, in one request.',
      body: `<p><code>?window=24h|7d|30d|90d</code> plus repeatable <code>environment</code>,
      <code>tag</code>, <code>owner</code>, <code>team</code>, <code>application</code> and
      <code>status</code> filters.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/api/dashboard/summary', permission: 'endpoint:read',
      summary: 'Just the summary cards. Cheap enough to poll.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/dashboard/availability', permission: 'endpoint:read',
      summary: 'Availability rows for one grouping.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/ssl/summary', permission: 'endpoint:read',
      summary: 'Certificate counts by state, plus expiry buckets.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/ssl', permission: 'endpoint:read',
      summary: 'Paginated certificate inventory, one row per endpoint.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/ssl/issuers', permission: 'endpoint:read',
      summary: 'Distinct issuer names, for the filter.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/ssl/export', permission: 'endpoint:export',
      summary: 'The whole filtered certificate inventory as an Excel workbook.' }),

    `<h2>Incidents and alerts</h2>`,

    DOCS.endpoint({ method: 'GET', path: '/api/incidents', permission: 'incident:read',
      summary: 'Incident history, newest first.',
      body: DOCS.table(['Parameter', 'Accepts'], [
        ['<code>endpoint_id</code>', 'UUID'],
        ['<code>status</code>', '<code>open</code>, <code>resolved</code>'],
        ['<code>severity</code>, <code>reason</code>', 'Repeatable'],
        ['<code>environment</code>, <code>tag</code>', 'UUIDs, joined through the endpoint'],
        ['<code>since</code>, <code>until</code>', 'ISO timestamps on <code>started_at</code>'],
        ['<code>min_duration_seconds</code>', 'Excludes shorter and unresolved incidents'],
        ['<code>search</code>', 'Endpoint name, URL, or the incident error message'],
        ['<code>sort_dir</code>', '<code>asc</code> or <code>desc</code>']
      ]) }),

    DOCS.endpoint({ method: 'GET', path: '/api/incidents/{id}', permission: 'incident:read',
      summary: 'One incident, with its timeline.' }),

    DOCS.endpoint({ method: 'PATCH', path: '/api/incidents/{id}', permission: 'incident:write',
      summary: 'Acknowledge or annotate.',
      body: DOCS.code(`{"acknowledge": true, "notes": "Upstream vendor incident; ticket VEN-4412."}`, 'request') +
        `<p><code>notes</code> is capped at 4000 characters. Both fields are optional.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/api/alerts', permission: 'alert:read',
      summary: 'Alert history, paginated and filterable.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/alerts/unacknowledged/count', permission: 'alert:read',
      summary: 'Counts for the navigation badge.' }),

    DOCS.endpoint({ method: 'POST', path: '/api/alerts/acknowledge', permission: 'alert:write',
      summary: 'Acknowledge a list of alerts.',
      body: DOCS.code(`{"alert_ids": [8812, 8813, 8814]}`, 'request') }),

    DOCS.endpoint({ method: 'DELETE', path: '/api/alerts/{id}', permission: 'alert:write',
      summary: 'Delete one alert.' }),

    `<h2>RCA and intelligence</h2>
    <p>Every <code>/api/rca/*</code> and <code>/api/incidents/{id}/rca*</code> route is additionally
    gated on <code>feature_rca_enabled</code>. The three <code>/api/intelligence/*</code> routes are
    not &mdash; the dashboard needs them whether or not the RCA module is on.</p>`,

    DOCS.endpoint({ method: 'GET', path: '/api/rca', permission: 'incident:read',
      summary: 'RCA list, filterable by status, owner, team, category, application and environment.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/rca/dashboard', permission: 'incident:read',
      summary: 'Counts, the open backlog and what is overdue.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/rca/analytics', permission: 'incident:read',
      summary: 'Aggregates over a window. ?window_days= defaults to 90.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/rca/options', permission: 'incident:read',
      summary: 'Categories, statuses, owners and teams for the filters and the assign dialog.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/rca/{id}', permission: 'incident:read',
      summary: 'One RCA, with its incident.' }),

    DOCS.endpoint({ method: 'PUT', path: '/api/rca/{id}', permission: 'incident:read + edit rights',
      summary: 'Save content. Does not complete it.',
      body: `<p>The route accepts any reader, then applies <code>can_edit</code>: an administrator,
      a holder of <code>incident:write</code>, <strong>or the assigned owner</strong> &mdash; which is
      what lets a viewer complete an RCA assigned to them or to their team.</p>` }),

    DOCS.endpoint({ method: 'POST', path: '/api/rca/{id}/assign', permission: 'incident:write',
      summary: 'Assign to a person or a team.',
      body: DOCS.code(`{"owner_type": "team", "owner_team": "DevOps", "due_in_days": 7}`, 'request') +
        DOCS.code(`{"owner_type": "individual", "owner_user_id": "0f2f...", "due_in_days": 0}`,
          'or, for an individual') }),

    DOCS.endpoint({ method: 'POST', path: '/api/rca/{id}/draft', permission: 'incident:read + edit rights',
      summary: 'Assemble a draft and a timeline from stored evidence.',
      body: `<p>Built entirely from local data &mdash; monitoring results, incidents, deployments, the
      stored diagnosis and the incident comments. Nothing leaves the server, and nothing is
      saved until the owner saves it.</p>` }),

    DOCS.endpoint({ method: 'POST', path: '/api/rca/{id}/complete', permission: 'incident:read + edit rights',
      summary: 'Sign it off.',
      body: `<p>400 unless both <code>root_cause</code> and <code>resolution</code> are non-empty.
      The incident is deliberately untouched.</p>` }),

    DOCS.endpoint({ method: 'POST', path: '/api/rca/{id}/reopen', permission: 'admin only',
      summary: 'Put a closed RCA back into progress, optionally reassigning it.',
      body: DOCS.code(`{"reason": "New evidence from the vendor", "owner_type": "individual",
 "owner_user_id": "0f2f...", "due_in_days": 5}`, 'request') +
        `<p>Reassignment is part of reopening rather than a second step: reopening without saying who
        leaves an RCA that is open, unowned, and therefore nobody&rsquo;s problem. The previous close
        is written to the timeline before it is cleared.</p>` }),

    DOCS.endpoint({ method: 'GET', path: '/api/incidents/{id}/rca', permission: 'incident:read',
      summary: 'The RCA for an incident, if any.' }),

    DOCS.endpoint({ method: 'POST', path: '/api/incidents/{id}/rca', permission: 'incident:write',
      summary: 'Request an RCA. Idempotent.',
      body: DOCS.code(`{"owner_type": "team", "owner_team": "Platform", "due_in_days": 7}`, 'request') }),

    DOCS.endpoint({ method: 'POST', path: '/api/incidents/{id}/rca/not-required', permission: 'incident:write',
      summary: 'Record a deliberate decision not to analyse this one.',
      body: DOCS.code(`{"reason": "Planned vendor maintenance, announced in advance."}`, 'request') }),

    DOCS.endpoint({ method: 'GET', path: '/api/incidents/{id}/comments', permission: 'incident:read',
      summary: 'The incident conversation.' }),

    DOCS.endpoint({ method: 'POST', path: '/api/incidents/{id}/comments', permission: 'incident:read',
      summary: 'Post a comment. Any reader may comment.',
      body: DOCS.code(`{"body": "Started right after the 14:02 deploy. Rolling back."}`, 'request') }),

    DOCS.endpoint({ method: 'GET', path: '/api/intelligence/summary', permission: 'incident:read',
      summary: 'What needs attention right now.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/intelligence/daily', permission: 'incident:read',
      summary: 'What happened over a period. ?hours=' }),

    DOCS.endpoint({ method: 'GET', path: '/api/intelligence/search', permission: 'incident:read',
      summary: 'Deterministic infrastructure search. ?q=' }),

    `<h2>Change management</h2>
    <p>Every route below is additionally gated on <code>feature_change_management_enabled</code>.</p>`,

    DOCS.endpoint({ method: 'GET', path: '/api/changes', permission: 'change:read',
      summary: 'List, filterable by search, status, application, environment, risk, requester and date.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/changes/dashboard', permission: 'change:read',
      summary: 'Counts, upcoming changes, active deployments and the overrunning subset.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/changes/options', permission: 'change:read',
      summary: 'Applications, environments, statuses and risks.' }),

    DOCS.endpoint({ method: 'POST', path: '/api/changes', permission: 'change:write',
      summary: 'Create a change in DRAFT.',
      body: DOCS.code(`{
  "title": "Payments API v2.4.0",
  "application": "payments",
  "environment": "production",
  "description": "Rolling upgrade of the payments service.",
  "expected_start_at": "2026-09-18T21:00:00Z",
  "expected_duration_minutes": 45,
  "risk": "medium",
  "rollback_plan": "helm rollback payments",
  "endpoint_ids": ["0f2f...", "7c81..."]
}`, 'request') }),

    DOCS.endpoint({ method: 'GET', path: '/api/changes/{id}', permission: 'change:read',
      summary: 'Full detail with comments and the activity timeline.' }),

    DOCS.endpoint({ method: 'PUT', path: '/api/changes/{id}', permission: 'change:write',
      summary: 'Edit. Only possible while DRAFT or PENDING_APPROVAL.' }),

    DOCS.endpoint({ method: 'POST', path: '/api/changes/{id}/submit', permission: 'change:write',
      summary: 'Submit. Auto-approves where the environment does not require approval.' }),

    DOCS.endpoint({ method: 'POST', path: '/api/changes/{id}/approve', permission: 'change:approve',
      summary: 'Approve. You cannot approve your own request.',
      body: DOCS.code(`{"comment": "Rollback plan verified."}`, 'request') }),

    DOCS.endpoint({ method: 'POST', path: '/api/changes/{id}/reject', permission: 'change:approve',
      summary: 'Reject. A reason is required.',
      body: DOCS.code(`{"reason": "No rollback plan for the schema migration."}`, 'request') }),

    DOCS.endpoint({ method: 'POST', path: '/api/changes/{id}/cancel', permission: 'change:write',
      summary: 'Cancel. Not available while a deployment is in progress.' }),

    DOCS.endpoint({ method: 'POST', path: '/api/changes/{id}/start-deployment', permission: 'change:deploy',
      summary: 'Begin. Pauses monitoring on the affected endpoints.',
      body: `<p>400 when the change is not APPROVED, or when another deployment is already running for
      the same application and environment &mdash; the message names the other change, who started it
      and when.</p>` }),

    DOCS.endpoint({ method: 'POST', path: '/api/changes/{id}/complete', permission: 'change:deploy',
      summary: 'Finish successfully. Resumes monitoring and health-checks.',
      body: DOCS.code(`{"deployment_notes": "Rolled out to all three replicas."}`, 'request') +
        `<p>Restricted to the person who started the deployment, or an administrator.</p>` }),

    DOCS.endpoint({ method: 'POST', path: '/api/changes/{id}/fail', permission: 'change:deploy',
      summary: 'Mark failed. A reason is required. Still resumes monitoring.',
      body: DOCS.code(`{"reason": "Migration timed out", "deployment_notes": "Rolled back to v2.3.1."}`,
        'request') }),

    DOCS.endpoint({ method: 'POST', path: '/api/changes/{id}/comments', permission: 'change:comment',
      summary: 'Comment. Up to 4000 characters.',
      body: DOCS.code(`{"body": "Traffic looks normal after the resume."}`, 'request') }),

    `<h2>Tags and environments</h2>`,

    DOCS.endpoint({ method: 'GET', path: '/api/tags', permission: 'endpoint:read', summary: 'List tags with usage counts.' }),
    DOCS.endpoint({ method: 'POST', path: '/api/tags', permission: 'tag:write', summary: 'Create a tag.',
      body: DOCS.code(`{"name": "critical", "color": "#ef4444", "description": "Customer-facing"}`, 'request') }),
    DOCS.endpoint({ method: 'PUT', path: '/api/tags/{id}', permission: 'tag:write', summary: 'Update a tag.' }),
    DOCS.endpoint({ method: 'DELETE', path: '/api/tags/{id}', permission: 'tag:write',
      summary: 'Delete a tag. ?force=true is required while endpoints still carry it.' }),

    DOCS.endpoint({ method: 'GET', path: '/api/environments', permission: 'endpoint:read',
      summary: 'List environments with their threshold overrides.' }),
    DOCS.endpoint({ method: 'POST', path: '/api/environments', permission: 'environment:write',
      summary: 'Create an environment.',
      body: DOCS.code(`{
  "name": "pre-prod", "display_name": "Pre-production",
  "color": "#f59e0b", "sort_order": 35, "is_active": true,
  "failure_threshold": 5, "response_time_threshold_ms": 4000
}`, 'request') }),
    DOCS.endpoint({ method: 'PUT', path: '/api/environments/{id}', permission: 'environment:write',
      summary: 'Update, including the threshold overrides. Null means inherit.' }),
    DOCS.endpoint({ method: 'DELETE', path: '/api/environments/{id}', permission: 'environment:write',
      summary: 'Delete. ?force=true is required while endpoints are still attached.' }),

    `<h2>Users</h2>`,

    DOCS.endpoint({ method: 'GET', path: '/api/users', permission: 'user:read',
      summary: 'List. ?search=, ?role=, ?is_active=' }),
    DOCS.endpoint({ method: 'GET', path: '/api/users/roles', permission: 'user:read',
      summary: 'Every role with its permission codes.' }),
    DOCS.endpoint({ method: 'POST', path: '/api/users', permission: 'user:write',
      summary: 'Create a user. 201 on success.',
      body: DOCS.code(`{
  "username": "asha",
  "email": "asha@example.com",
  "full_name": "Asha Rao",
  "team": "platform",
  "password": "<temporary password>",
  "role": "approver",
  "is_active": true,
  "must_change_password": true
}`, 'request') +
        `<p>409 on a duplicate username or e-mail; 422 when the password fails the policy.</p>` }),
    DOCS.endpoint({ method: 'GET', path: '/api/users/{id}', permission: 'user:read', summary: 'One user.' }),
    DOCS.endpoint({ method: 'PUT', path: '/api/users/{id}', permission: 'user:write',
      summary: 'Update details, role or status.',
      body: `<p>400 when the change would remove the last active administrator.</p>` }),
    DOCS.endpoint({ method: 'POST', path: '/api/users/{id}/reset-password', permission: 'user:write',
      summary: 'Set a new password. Invalidates all of that user’s sessions.',
      body: DOCS.code(`{"new_password": "<temporary password>", "force_change": true}`, 'request') }),
    DOCS.endpoint({ method: 'POST', path: '/api/users/{id}/reset-lockout', permission: 'user:write',
      summary: 'Clear both the account lockout and the login rate limit.' }),
    DOCS.endpoint({ method: 'DELETE', path: '/api/users/{id}', permission: 'user:write',
      summary: 'Delete. 400 for the last active administrator.' }),

    `<h2>Settings, audit and notifications</h2>`,

    DOCS.endpoint({ method: 'GET', path: '/api/settings', permission: 'settings:read',
      summary: 'Every setting with its value, type, label, description and bounds.' }),
    DOCS.endpoint({ method: 'PUT', path: '/api/settings', permission: 'settings:write',
      summary: 'Update a batch. Nothing is written unless every value validates.',
      body: DOCS.code(`{"updates": {"failure_threshold": 4, "ssl_warning_days": 45,
             "fast_check_environments": ["production", "pre-prod"]}}`, 'request') +
        `<p>400 naming the first problem found &mdash; an unknown key, a value out of range, or an
        SSL critical threshold above the warning threshold.</p>` }),
    DOCS.endpoint({ method: 'GET', path: '/api/features', permission: 'any signed-in user',
      summary: 'The module flags the navigation needs.',
      body: `<p>Deliberately open to every authenticated role: the navigation needs these, and most
      roles hold no <code>settings:read</code>.</p>` }),
    DOCS.endpoint({ method: 'GET', path: '/api/settings/alert-options', auth: false,
      summary: 'Alert types, severities, channel types, audit actions and allowed intervals.',
      body: `<p>This route declares <strong>no authentication dependency</strong> &mdash; it takes
      only the runtime config, which itself depends on nothing but a database session. It is
      therefore reachable without a token, unlike every other route under <code>/api</code>. What it
      returns is enum values plus <code>allowed_intervals</code>, so nothing about the monitored
      fleet is exposed, but it is worth knowing when reasoning about the attack surface.</p>` }),
    DOCS.endpoint({ method: 'POST', path: '/api/settings/branding/logo', permission: 'settings:write',
      summary: 'Upload a logo. multipart/form-data, field name "file".' }),
    DOCS.endpoint({ method: 'DELETE', path: '/api/settings/branding/logo', permission: 'settings:write',
      summary: 'Remove the uploaded logo.' }),
    DOCS.endpoint({ method: 'GET', path: '/api/audit-logs', permission: 'audit:read',
      summary: 'The audit trail, filterable and paginated.' }),
    DOCS.endpoint({ method: 'GET', path: '/api/audit-logs/actions', permission: 'audit:read',
      summary: 'The distinct actions present, for the filter.' }),
    DOCS.endpoint({ method: 'GET', path: '/api/notification-channels', permission: 'settings:read',
      summary: 'Channels, with only their non-sensitive configuration.' }),
    DOCS.endpoint({ method: 'POST', path: '/api/notification-channels', permission: 'notification:write',
      summary: 'Create a channel.',
      body: DOCS.code(`{
  "name": "Platform Slack",
  "channel_type": "slack",
  "is_enabled": true,
  "min_severity": "warning",
  "event_types": ["endpoint_down", "endpoint_recovered", "ssl_expiring"],
  "environment_filter": ["production"],
  "tag_filter": [],
  "config": {"webhook_url": "<the incoming-webhook URL>"}
}`, 'request') +
        `<p>The whole <code>config</code> object is encrypted before storage. The response contains
        only <code>config_public</code>. Note that <code>environment_filter</code> and
        <code>tag_filter</code> hold <strong>names</strong>, not UUIDs &mdash; they are matched
        against the endpoint&rsquo;s environment name and tag names.</p>` }),
    DOCS.endpoint({ method: 'PUT', path: '/api/notification-channels/{id}', permission: 'notification:write',
      summary: 'Update. Omitting config keeps the stored one.',
      body: `<p><code>channel_type</code> is not accepted here: a channel&rsquo;s type is fixed once
      created. Delete and recreate to change it.</p>` }),
    DOCS.endpoint({ method: 'POST', path: '/api/notification-channels/{id}/test', permission: 'notification:write',
      summary: 'Deliver a synthetic payload to verify the channel.' }),
    DOCS.endpoint({ method: 'DELETE', path: '/api/notification-channels/{id}', permission: 'notification:write',
      summary: 'Delete a channel.' }),

    `<h2>Import and export</h2>`,

    DOCS.endpoint({ method: 'GET', path: '/api/import/template', permission: 'endpoint:import',
      summary: 'A CSV template with the supported columns.' }),
    DOCS.endpoint({ method: 'POST', path: '/api/import', permission: 'endpoint:import',
      summary: 'Upload and validate. Writes nothing.',
      body: `<p><code>multipart/form-data</code>, field name <code>file</code>. Returns a
      <code>token</code> and a per-row preview with errors, warnings and duplicate flags. The token is
      valid for 15 minutes.</p>` }),
    DOCS.endpoint({ method: 'POST', path: '/api/import/confirm', permission: 'endpoint:import',
      summary: 'Create the confirmed rows.',
      body: DOCS.code(`{"token": "<from the preview>", "row_numbers": [2, 3, 5, 8]}`, 'request') +
        `<p>Omitting <code>row_numbers</code> imports every valid row. Each is created inside its own
        SAVEPOINT, so one late failure does not discard the rows that already succeeded.</p>` }),
    DOCS.endpoint({ method: 'GET', path: '/api/export', permission: 'endpoint:export',
      summary: 'Export the configuration as CSV or Excel.',
      body: `<p><code>?format=csv|xlsx</code>, plus the same <code>search</code>,
      <code>environment</code>, <code>tag</code>, <code>status</code> and
      <code>monitoring_enabled</code> filters as the endpoint list &mdash; so &ldquo;export what I am
      looking at&rdquo; works. Credentials are never included; only the authentication
      <em>type</em> is exported, because the file leaves the application.</p>` })

  ].join('\n')
});
