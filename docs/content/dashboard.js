DOCS.page({
  id: 'dashboard',
  title: 'Dashboard and metrics',
  description: 'What the dashboard shows, exactly how each number is computed, and what the screen does while it loads or fails.',
  body: [

    `<h2>One request, one moment in time</h2>
    <p><code>GET /api/dashboard</code> answers the whole screen. Separate requests could straddle a
    check cycle and disagree with each other, so the cards, the charts and the incident list are
    guaranteed to describe the same instant &mdash; stamped as <code>generated_at</code>.</p>`,

    DOCS.table(['Block', 'Field', 'Source'], [
      ['Summary cards', '<code>summary</code>', '<code>stats_service.dashboard_summary</code>'],
      ['Latency chart', '<code>response_time_series</code>', '<code>global_response_time_series</code>'],
      ['Availability by group', '<code>availability_by_environment</code>, ' +
       '<code>availability_by_tag</code>, <code>availability_by_team</code>',
       '<code>availability_by_group</code>, called once per grouping'],
      ['Certificate timeline', '<code>ssl_expiry_timeline</code>', '<code>ssl_expiry_timeline</code>'],
      ['Rankings', '<code>top_failing_endpoints</code>, <code>slowest_endpoints</code>',
       '<code>failure_counts</code>, <code>slowest_endpoints</code>'],
      ['Incidents', '<code>open_incidents</code> (25), <code>recent_incidents</code> (15)',
       '<code>recent_incidents</code>, twice'],
      ['SLA', '<code>sla_target</code>, <code>sla_breaches</code>',
       'The <code>uptime_sla_target</code> setting, applied to the per-environment availability']
    ]),

    `<h2>Windows and filters</h2>
    <p><code>window</code> must be one of <code>24h</code>, <code>7d</code>, <code>30d</code>,
    <code>90d</code> &mdash; enforced by a regex on the query parameter, so an unexpected value is a
    422 rather than a silent fallback.</p>

    <p>Filters are repeatable query parameters and combine as <strong>AND across dimensions, OR within
    one</strong>: <code>?status=down&amp;environment=&lt;prod&gt;&amp;tag=&lt;backend&gt;</code> reads
    as &ldquo;down endpoints in production tagged backend&rdquo;. The available dimensions are
    <code>environment</code>, <code>tag</code>, <code>owner</code>, <code>team</code>,
    <code>application</code> and <code>status</code>. Both <code>?status=up&amp;status=down</code> and
    <code>?status=up,down</code> are accepted.</p>`,

    `<h2>How each number is computed</h2>

    <h3>Status counts</h3>
    <p>A <code>GROUP BY current_status</code> over the filtered endpoint set. These are <em>live
    state</em>, not a window aggregate &mdash; they describe what each endpoint is right now.</p>

    <p><code>paused</code> is counted separately and more broadly: it is the number of filtered
    endpoints where <code>is_paused</code> is true <strong>or</strong>
    <code>monitoring_enabled</code> is false.</p>

    <h3>Certificate counts</h3>
    <p>A <code>GROUP BY ssl_status</code> over filtered endpoints that have
    <code>ssl_monitoring_enabled</code>. <code>ssl_certificates</code> is the tracked total with
    <code>not_applicable</code> excluded, so an estate of plain-HTTP endpoints does not inflate
    it.</p>

    <h3>Uptime</h3>`,

    DOCS.code(`uptime_percent = (total_checks - failed_checks) / total_checks * 100`,
      'stats_service - the definition used everywhere'),

    DOCS.callout('note', 'Uptime is check-based, and degraded counts as up',
      '<p>Only checks with <code>status = down</code> count against uptime. A ' +
      '<code>degraded</code> check &mdash; successful but slower than the latency threshold &mdash; ' +
      'is a success here: the endpoint answered correctly. This is a ratio of checks, not of ' +
      'seconds, so an endpoint on a 5-minute interval and one on a 30-second interval contribute ' +
      'proportionally different numbers of samples over the same window.</p>' +
      '<p>Time-based downtime is reported separately, per endpoint, as ' +
      '<code>downtime_seconds</code> &mdash; derived from incident durations clipped to the ' +
      'window.</p>'),

    `<p>A group with no checks in the window returns <code>null</code> rather than 0%, so &ldquo;we
    have no data&rdquo; is never rendered as &ldquo;total outage&rdquo;.</p>

    <h3>Availability by group</h3>
    <p>Each row carries two different measures, which are easy to confuse:</p>`,

    DOCS.table(['Field', 'Means'], [
      ['<code>health_percent</code>',
       'The share of endpoints in the group that are currently healthy. A snapshot of <em>now</em>.'],
      ['<code>uptime_percent</code>',
       'Checks that passed, over all checks for the group&rsquo;s endpoints <em>in the window</em>. ' +
       'A history.']
    ]),

    `<p>Grouping by team or owner puts endpoints with a NULL value into an
    <strong>Unassigned</strong> bucket rather than dropping them.</p>

    <h3>Latency series</h3>
    <p>Results are bucketed by time, with the bucket size chosen to give a readable number of points
    rather than being fixed:</p>`,

    DOCS.code(`raw = max(60, span_seconds // 120)
bucket = first of (60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400)
         that is >= raw`, 'stats_service.choose_bucket_seconds'),

    `<p>Each point reports the check count, average/min/max response time, failed and degraded counts,
    the uptime for that bucket, and average DNS, connect and TLS times &mdash; which is what makes it
    possible to see that latency rose because handshakes got slower rather than because the
    application did.</p>

    <h3>Percentiles</h3>
    <p>Per-endpoint statistics include <code>p95_response_time_ms</code>, computed by
    <code>_percentile_response_time</code> over the window. Averages hide the tail; p95 is what an
    operator argues about.</p>

    <h3>SLA breaches</h3>
    <p><code>sla_breaches</code> is the per-environment availability rows whose
    <code>uptime_percent</code> is below <code>uptime_sla_target</code> (default 99.9). Rows with no
    data are not breaches.</p>`,

    `<h2>Cheaper routes for polling</h2>
    <p>The full dashboard route is roughly twenty aggregate queries. Two lighter routes exist for
    screens that only need part of it:</p>`,

    DOCS.table(['Route', 'Returns', 'Use'], [
      ['<code>GET /api/dashboard/summary</code>', 'Just <code>SummaryCards</code>',
       'Cheap enough to poll on a short interval'],
      ['<code>GET /api/dashboard/availability</code>',
       'Just the group rows, for one <code>group_by</code>',
       'Feeding a single chart'],
      ['<code>GET /api/endpoints/summary</code>', 'Status counts only',
       'The header chips on the endpoint list, which double as status filters']
    ]),

    `<h2>Refresh behaviour</h2>
    <p>Screens poll through <code>useAutoRefresh</code> rather than offering a reload button. The
    three rules that make polling tolerable:</p>

    <ol>
      <li><strong>Nothing runs in a hidden tab.</strong> A dashboard left open on a second monitor
      overnight should not spend the night querying. Polling stops on <code>visibilitychange</code>
      and resumes with an immediate fetch, so returning to the tab shows current data rather than a
      countdown.</li>
      <li><strong>A refresh never interrupts.</strong> Callers pass <code>paused</code> while the user
      is mid-edit. A background fetch that overwrites a half-written comment or an unsaved RCA is far
      worse than slightly stale data.</li>
      <li><strong>Overlaps are skipped, not queued.</strong> If a fetch is slower than the interval,
      the next tick is dropped rather than stacking requests on a backend that is evidently already
      struggling.</li>
    </ol>

    <p>Two cadences are exported: <code>LIVE_INTERVAL</code> = 10s for conversation-like surfaces
    (comments, an active incident) and <code>SLOW_INTERVAL</code> = 30s for aggregates. The hook
    returns <code>{refreshing, lastRefreshedAt, refreshNow}</code>; <code>refreshNow</code> exists for
    code that needs to force a read after an action, not as a button.</p>`,

    `<h2>Loading and error states</h2>`,

    DOCS.table(['State', 'What the user sees'], [
      ['Initial app load while the stored token is being revalidated',
       'A full-page spinner from <code>App.jsx</code>. The token may have expired or the role may ' +
       'have changed since it was issued, so <code>GET /api/auth/me</code> is always called on ' +
       'load.'],
      ['Navigating to a lazily-loaded screen',
       'A centred route-level spinner inside the layout, so the shell and navigation stay put.'],
      ['A background poll',
       'A subtle live indicator. Content is not blanked &mdash; the previous data stays on screen ' +
       'until the new data replaces it.'],
      ['API unreachable (no response at all)',
       '&ldquo;Cannot reach the server. Check your connection.&rdquo;'],
      ['nginx answered 502 because the backend is down',
       '&ldquo;The API is not responding. The backend service may be starting up, or it may have ' +
       'failed &mdash; check <code>docker compose ps</code> and <code>docker compose logs ' +
       'backend</code>.&rdquo; The client detects an HTML body and keeps its own message rather than ' +
       'rendering nginx&rsquo;s error page.'],
      ['API returned 503',
       '&ldquo;The API is temporarily unavailable. It may still be starting up.&rdquo; &mdash; which ' +
       'is what a database-error handler or a not-ready instance produces.'],
      ['Validation failure on a form',
       'Per-field messages from the <code>fields</code> map in the 422 body.'],
      ['Session expired and refresh failed',
       'Tokens cleared, redirect to sign-in, &ldquo;Your session expired. Please sign in ' +
       'again.&rdquo;'],
      ['Password change required',
       'Redirect to the password screen, driven by the ' +
       '<code>X-Password-Change-Required</code> header rather than by guessing at a 403.']
    ]),

    `<h2>Other operational screens</h2>`,

    DOCS.cards([
      { kicker: 'Route /system', title: 'System resources',
        body: 'InfraSight’s own disk, database size and per-table breakdown, API and worker CPU ' +
              'and memory, the worker fleet, and where each vantage exits. Requires ' +
              '<code>settings:read</code>.' },
      { kicker: 'Route /audit-logs', title: 'Audit log',
        body: 'Every administrative mutation, filterable by action, user, resource and date. ' +
              'Requires <code>audit:read</code>, which only admins hold.' },
      { kicker: 'Route /alerts', title: 'Alerts',
        body: 'Alert history with acknowledgement, plus an unacknowledged count the navigation badge ' +
              'reads.' },
      { kicker: 'Endpoint detail', title: 'Per-endpoint view',
        body: 'Statistics per window, the result history, the latency series, certificate detail and ' +
              'history, what the hostname resolves to, captures, and Diagnose.' }
    ]),

    `<h2>Watching InfraSight itself</h2>
    <p>A monitoring tool that runs out of disk stops monitoring, and does so silently &mdash; checks
    just stop being recorded. <code>GET /api/system/resources</code> asks the same questions of
    InfraSight that InfraSight asks of everything else.</p>`,

    DOCS.table(['Measured', 'How'], [
      ['API CPU and memory', 'The API process reads its own cgroup (v1 or v2 layout)'],
      ['Worker CPU and memory',
       'The worker measures its own cgroup and carries the numbers on the heartbeat row it already ' +
       'writes &mdash; so no channel to the worker is needed'],
      ['PostgreSQL', 'Over SQL: database size, per-table breakdown, connections, cache hit ratio'],
      ['Redis', 'Its own <code>INFO</code> output'],
      ['Disk', 'The container root filesystem, which on the default Compose topology is backed by ' +
       'the same host device as the postgres volume'],
      ['nginx', 'Nothing. It is listed in <code>not_measured</code> rather than guessed at.']
    ]),

    DOCS.callout('warn', 'No Docker socket, on purpose',
      '<p>Mounting <code>/var/run/docker.sock</code> into the API container would give a ' +
      '<code>docker stats</code> view of all five services in three lines of code. It would also ' +
      'hand host root to anyone who compromised a network-facing container. That is a bad trade for ' +
      'a resource graph, so what cannot be measured without it is named in <code>not_measured</code> ' +
      'instead of left blank.</p>'),

    `<h3>CPU is a rate</h3>
    <p>A percentage needs two samples, so the first reading after a process starts honestly reports
    <code>null</code>. The heartbeat writer keeps the previous value rather than blanking a good
    reading when the current sample is unavailable.</p>`

  ].join('\n')
});
