DOCS.page({
  id: 'monitoring',
  title: 'Monitoring engine',
  description: 'How a check is scheduled, executed, judged and recorded, and every rule that decides whether an endpoint is up.',
  body: [

    `<h2>The complete lifecycle</h2>`,

    DOCS.diagram(`
   +---------------------------------------------------------------+
   |  SCHEDULE                                                      |
   |  endpoints.next_check_at <= now, not paused, lease free        |
   |  claimed with FOR UPDATE SKIP LOCKED + a lease                 |
   +-------------------------------+-------------------------------+
                                   |
   +-------------------------------v-------------------------------+
   |  PROBE   checker.run_check(target)        (no database)        |
   |                                                                |
   |   1. DNS        getaddrinfo, IPv4 preferred, timing recorded   |
   |        |  failure -> dns_failure, stop                         |
   |   2. POLICY     is_blocked_address(ip)                         |
   |        |  blocked -> blocked_target, stop                      |
   |   3. PROTOCOL   http | tcp | tls                               |
   |        |                                                       |
   |        +-- http: request, stream the body, keep the first 64KB |
   |        |         evaluate status, substring, latency           |
   |        |         + health-path discovery when 404/405/410/501  |
   |        +-- tcp : open_connection, time it                      |
   |        +-- tls : handshake and describe the certificate        |
   |   4. CERT       fallback probe_tls() when HTTPS gave no cert    |
   |   5. VERDICT    up | degraded | down + a failure_reason        |
   +-------------------------------+-------------------------------+
                                   |
   +-------------------------------v-------------------------------+
   |  CONFIRM (only on the failure that reaches the threshold,      |
   |           only when VANTAGE_POINTS is configured)              |
   |  re-check through each proxy -> withhold the incident, or not  |
   +-------------------------------+-------------------------------+
                                   |
   +-------------------------------v-------------------------------+
   |  RECORD   monitoring_service.record_check_result()             |
   |                                                                |
   |   INSERT monitoring_results                                    |
   |   UPDATE endpoints: last_*, counters, current_status, ssl_*    |
   |   UPSERT ssl_certificates (new row on fingerprint change)      |
   |   OPEN / EXTEND / CLOSE the incident                           |
   |   RAISE alerts (cooldown applies) -> dispatch notifications    |
   |   REPLACE the success or failure capture row                   |
   +-------------------------------+-------------------------------+
                                   |
   +-------------------------------v-------------------------------+
   |  RESCHEDULE   next_check_at = now + resolved interval + jitter |
   |               lease released                                   |
   +-------------------------------+-------------------------------+
                                   |
                        (optional) SCREENSHOT, after the commit
`, 'One pass of the worker’s check loop, for one endpoint.'),

    `<h2>Check types</h2>
    <p>Set per endpoint as <code>check_type</code>. All three share the DNS stage, the blocked-address
    policy, the retry rule and the recording path.</p>`,

    DOCS.table(['Type', 'What it does', 'Judged up when'], [
      ['<code>http</code> <em>(default)</em>',
       'Full HTTP request with the configured method, headers, auth and body. Streams the response ' +
       'to measure its length and keeps the first 64&nbsp;KB.',
       'The status code is in <code>expected_status_codes</code> <em>and</em> the body substring ' +
       'matched (if one is configured).'],
      ['<code>tcp</code>',
       'Opens a TCP connection to the host and port and closes it. No TLS, no HTTP.',
       'The connection is accepted within <code>timeout_seconds</code>.'],
      ['<code>tls</code>',
       'Completes a TLS handshake and describes the presented certificate. No HTTP request.',
       'The handshake succeeded and the certificate is not expired, invalid or unreadable.']
    ]),

    `<h2>What a single HTTP check measures</h2>`,

    DOCS.table(['Field', 'Source'], [
      ['<code>dns_time_ms</code>',
       '<code>loop.getaddrinfo</code>, measured separately before the request. An IP literal ' +
       'short-circuits with zero rather than a fake measurement.'],
      ['<code>connect_time_ms</code>, <code>tls_time_ms</code>',
       'A wrapper around httpcore&rsquo;s network backend times the connect and ' +
       '<code>start_tls</code> phases on the very connection the request uses &mdash; no second ' +
       'probe and no extra load on the monitored host. If a future httpcore changes that interface, ' +
       'the client falls back to the stock transport and these are reported as <code>null</code>; ' +
       'the check keeps working.'],
      ['<code>ttfb_ms</code>', 'Wall clock from sending the request to the response headers arriving.'],
      ['<code>total_time_ms</code>, <code>response_time_ms</code>',
       'Wall clock including streaming the body. These two are the same value for an HTTP check.'],
      ['<code>resolved_ip</code>',
       'The <code>server_addr</code> extra-info from the network stream, falling back to the DNS result.'],
      ['<code>content_length</code>', 'Bytes actually streamed, not the header value.'],
      ['<code>redirect_count</code>, <code>redirect_chain</code>, <code>final_url</code>',
       'From <code>response.history</code>. Each hop records status, URL and Location.'],
      ['<code>response_headers</code>',
       'An allow-list of 14 headers, each truncated to 512 characters. Storing every header would ' +
       'bloat the table and risk capturing session cookies.'],
      ['<code>tls_version</code>, <code>tls_cipher</code>, certificate fields',
       'Pulled off the live <code>ssl_object</code> of the socket that served the request.'],
      ['<code>retry_count</code>',
       'How many retries it took to reach this outcome. 0 means the first attempt produced it.']
    ]),

    DOCS.callout('warn', 'Response bodies are not stored in monitoring_results',
      '<p>The probe streams the body to measure it and keeps the first 64&nbsp;KB in memory for two ' +
      'purposes only: the configured substring match, and the capture row. The high-volume ' +
      '<code>monitoring_results</code> table records the byte count and the allow-listed headers, ' +
      'never the body &mdash; monitoring must not become an accidental data-exfiltration path. See ' +
      '<a href="#/endpoints#captures">captures</a> for what is kept and where.</p>'),

    `<h3>Headers sent</h3>
    <p><code>build_headers</code> always sends <code>User-Agent: InfraSight/1.0
    (+endpoint-health-check)</code>, <code>Accept: */*</code>, <code>Accept-Encoding: identity</code>
    and <code>Cache-Control: no-cache</code>, then any <code>custom_headers</code>, then the
    credential for the configured <code>auth_type</code>.</p>`,

    DOCS.table(['auth_type', 'Header sent'], [
      ['<code>none</code>', 'Nothing.'],
      ['<code>bearer</code>', '<code>Authorization: Bearer &lt;secret&gt;</code>'],
      ['<code>basic</code>', '<code>Authorization: Basic base64(username:secret)</code>'],
      ['<code>header</code>', '<code>&lt;auth_header_name&gt;: &lt;secret&gt;</code>']
    ]),

    `<p>The secret is stored Fernet-encrypted in <code>auth_secret_encrypted</code> and decrypted only
    inside <code>execute_check</code>. It is never serialised back to a client; the API returns
    <code>auth_secret_hint</code>, a mask such as <code>****abcd</code>. If decryption fails &mdash;
    normally because <code>ENCRYPTION_KEY</code> or <code>JWT_SECRET</code> was rotated &mdash; the
    check is recorded as a <code>config_error</code> failure with the message &ldquo;Stored
    credentials could not be decrypted; re-enter the endpoint authentication settings&rdquo; rather
    than crashing the worker.</p>`,

    `<h2>Failure reasons</h2>
    <p>Every failed check carries exactly one <code>failure_reason</code>. This is the vocabulary the
    incident list, the alert text and the diagnostics engine all use.</p>`,

    DOCS.table(['Reason', 'Means', 'Raised by'], [
      ['<code>dns_failure</code>', 'DNS resolution failed, timed out, or returned no addresses',
       'The DNS stage, or an httpx <code>ConnectError</code> whose text mentions name resolution'],
      ['<code>connection_refused</code>', 'The host answered the SYN with a refusal, or the connection otherwise failed',
       'TCP check, or httpx <code>ConnectError</code>'],
      ['<code>connection_timeout</code>', 'No connection within the timeout',
       '<code>ConnectTimeout</code>, <code>PoolTimeout</code>, any other <code>TimeoutException</code>'],
      ['<code>read_timeout</code>', 'Connected, but no response body in time',
       '<code>ReadTimeout</code>, <code>WriteTimeout</code>'],
      ['<code>tls_error</code>', 'Handshake failed, or a TLS check could not complete',
       '<code>ConnectError</code> mentioning certificate/SSL/TLS, or a TLS probe error'],
      ['<code>cert_expired</code>', 'The presented certificate is past <code>notAfter</code>',
       'The certificate check &mdash; a hard failure on a verifying HTTPS check <em>even if the ' +
       'server answered</em>'],
      ['<code>cert_invalid</code>', 'The certificate is structurally invalid or failed verification',
       'TLS check classification'],
      ['<code>http_status_mismatch</code>', 'Unexpected status code, <em>or</em> the expected body substring was absent',
       'The HTTP verdict'],
      ['<code>too_many_redirects</code>', 'httpx gave up following the chain', '<code>TooManyRedirects</code>'],
      ['<code>slow_response</code>', 'Successful but over the latency threshold. This is the ' +
       '<strong>degraded</strong> state, not a hard failure.', 'The HTTP or TCP verdict'],
      ['<code>blocked_target</code>', 'The resolved address is one InfraSight refuses to probe',
       '<code>is_blocked_address</code>, before the request or on a redirect hop'],
      ['<code>config_error</code>', 'The endpoint cannot be checked as configured &mdash; e.g. an ' +
       'undecryptable credential, an invalid URL', '<code>execute_check</code>, <code>InvalidURL</code>'],
      ['<code>unknown_error</code>', 'Anything else', 'Protocol and transport errors']
    ]),

    `<h2>Status transitions</h2>
    <p>Two different state values, which is a frequent source of confusion:</p>

    <ul>
      <li><code>CheckStatus</code> &mdash; what <em>one check</em> concluded:
      <code>up</code>, <code>degraded</code>, <code>down</code>. Stored on every
      <code>monitoring_results</code> row.</li>
      <li><code>EndpointStatus</code> &mdash; what the <em>endpoint</em> currently is:
      <code>unknown</code>, <code>up</code>, <code>degraded</code>, <code>down</code>,
      <code>paused</code>. Stored on <code>endpoints.current_status</code>.</li>
    </ul>`,

    DOCS.diagram(`
                          created
                             |
                             v
                        +---------+
                        | UNKNOWN |
                        +----+----+
                             |
            first check      |
        +--------------------+--------------------+
        |                    |                    |
        v                    v                    v
   +---------+  slow    +----------+  fail   +---------+
   |   UP    |--------->| DEGRADED |-------->|  DOWN   |
   |         |<---------|          |<--------|         |
   +----+----+  fast    +----------+   pass  +----+----+
        |                                          |
        |          pause / disable / deploy        |
        +------------------+  +--------------------+
                           v  v
                       +----------+
                       |  PAUSED  |
                       +----+-----+
                            |
                     resume | next_check_at = now
                            v
                       +----------+
                       | UNKNOWN  |   (a paused endpoint's old status is not
                       +----------+    evidence about the present)
`, 'Every up or degraded check clears consecutive_failures; every failed check clears consecutive_successes.'),

    `<h3>What each recorded check does</h3>`,

    DOCS.table(['Outcome', 'Endpoint counters', 'current_status becomes'], [
      ['<code>up</code>',
       '<code>consecutive_successes += 1</code>, <code>consecutive_failures = 0</code>, ' +
       '<code>total_checks += 1</code>',
       '<code>up</code>'],
      ['<code>degraded</code>',
       'Same as <code>up</code> &mdash; it counts as a success, and does <strong>not</strong> ' +
       'increment <code>total_failures</code>',
       '<code>degraded</code>'],
      ['<code>down</code>',
       '<code>consecutive_failures += 1</code>, <code>consecutive_successes = 0</code>, ' +
       '<code>total_failures += 1</code>, <code>total_checks += 1</code>',
       '<code>down</code> &mdash; immediately, on the first failure']
    ]),

    DOCS.callout('note', 'DOWN status and an open incident are not the same thing',
      '<p>The endpoint reads <code>down</code> from the first failed check, because it is. The ' +
      '<em>incident</em> only opens once <code>consecutive_failures</code> reaches ' +
      '<code>failure_threshold</code>. That is what keeps a single blip off the pager while still ' +
      'showing the truth on the dashboard.</p>'),

    `<h3>Incident transitions</h3>`,

    DOCS.diagram(`
  failed check
     |
     +-- an incident is already open?
     |      YES -> failed_check_count += 1
     |              if the reason changed, append a "reason_changed" timeline
     |              entry and update reason/error_message. No new alert.
     |      NO  -> continue
     |
     +-- consecutive_failures >= failure_threshold ?
     |      NO  -> nothing further. Just a recorded failure.
     |      YES -> continue
     |
     +-- the vantage gate returned a withhold reason?
     |      YES -> log incident_withheld, record the reason, open nothing.
     |             The very next failing check gets no second reprieve.
     |      NO  -> continue
     |
     +-- a RESOLVED incident on this endpoint within
     |   incident_grouping_minutes, with NO RCA attached?
     |      YES -> REOPEN it: status=open, resolved_at=NULL,
     |             failed_check_count += failures, "reopened" timeline entry
     |      NO  -> OPEN a new one, inside a SAVEPOINT
     |
     +-- raise ENDPOINT_DOWN (critical)

  and separately, on the same path:
     +-- consecutive_failures == failure_threshold * 4
            -> raise REPEATED_FAILURES (critical), one escalation notice


  successful check, with an incident open
     |
     +-- consecutive_successes >= recovery_threshold (default 1)?
            YES -> CLOSE it: resolved_at, duration_seconds,
                   recovery_status_code, recovery_response_time_ms,
                   "resolved" timeline entry
                -> raise ENDPOINT_RECOVERED (info, exempt from cooldown)
`, 'Incident grouping is why a flapping endpoint reads as one problem rather than a wall of separate incidents. An incident that already has an RCA is never regrouped: one already written up must not be silently extended with a second occurrence’s data underneath its owner’s back.'),

    DOCS.callout('tip', 'Two workers cannot open two incidents',
      '<p>A partial unique index &mdash; <code>uq_incidents_one_open_per_endpoint</code> on ' +
      '<code>endpoint_id WHERE status = \'open\'</code> &mdash; is the database-level guarantee. ' +
      '<code>_open_incident</code> inserts inside a <code>SAVEPOINT</code>; on conflict it adopts the ' +
      'row the other worker created and logs <code>incident_open_race_resolved</code>. Only the ' +
      'incident is rolled back, so the monitoring result written earlier in the same transaction ' +
      'survives.</p>'),

    `<h2>Check cadence</h2>
    <p>The interval is resolved on every check from the environment and the last outcome, not read
    from the stored <code>interval_seconds</code> alone. That means a settings change takes effect on
    the next check instead of needing a backfill.</p>`,

    DOCS.code(`interval = endpoint.interval_seconds or default_monitor_interval

if is_fast_check_environment(endpoint, config):      # name in fast_check_environments
    interval = min(interval, fast_check_interval)    # default 60s

if endpoint.consecutive_failures > 0:
    interval = min(interval, failure_recheck_interval)   # default 60s

return max(MIN_MONITOR_INTERVAL, interval)           # hard floor, default 30s`,
      'app/services/monitoring_service.py - resolve_check_interval'),

    DOCS.table(['Rule', 'Cadence', 'Why'], [
      ['<strong>Fast-check environment</strong> (<code>production</code> by default)',
       '<code>fast_check_interval</code>, whether the last check passed or failed',
       'The point of production monitoring is to notice the <em>first</em> failure quickly, which ' +
       'cannot happen if the fast cadence only starts after one.'],
      ['<strong>Anything that just failed</strong>',
       '<code>failure_recheck_interval</code> until it passes, then straight back to its own interval ' +
       'on the first success',
       'A five-minute interval would otherwise mean a five-minute-old view of an outage, and five ' +
       'minutes of guessing whether it has recovered.'],
      ['<strong>Everything else</strong>',
       'Its own <code>interval_seconds</code>, defaulting to ' +
       '<code>DEFAULT_MONITOR_INTERVAL</code> (300s)',
       'Most endpoints are not production, and a one-minute sweep over a large non-production estate ' +
       'is mostly load with no reader.']
    ]),

    DOCS.callout('note', 'Every rule takes the smaller value',
      '<p>These are ceilings on staleness, never slow-downs. An endpoint deliberately set to 30 ' +
      'seconds is not slowed to 60 by being in production, and a failing production endpoint gets ' +
      'whichever of the two intervals is shorter. An endpoint with no environment is never treated ' +
      'as production &mdash; guessing that from a URL would be worse than making the operator say ' +
      'so.</p>'),

    `<h3>Jitter</h3>
    <p><code>next_check_time</code> applies a &plusmn;10% random offset, with a floor of 5 seconds.
    Without it, endpoints created by a bulk import share a due time forever and arrive as a
    thundering herd every interval.</p>`,

    `<h2>Timeouts, retries and the safety floor</h2>`,

    DOCS.table(['Control', 'Default', 'Enforced where'], [
      ['<code>timeout_seconds</code> per endpoint', '10',
       'Clamped to 1&ndash;120 <em>and</em> to no more than the interval &mdash; a timeout longer ' +
       'than the interval guarantees overlapping checks.'],
      ['<code>MIN_MONITOR_INTERVAL</code>', '30s',
       'Server-side floor on any interval, applied both when saving an endpoint and again in ' +
       '<code>resolve_check_interval</code>, so a mis-set runtime setting cannot turn the monitor ' +
       'into a load generator.'],
      ['<code>MAX_MONITOR_INTERVAL</code>', '86400s', 'Upper clamp on a configured interval.'],
      ['<code>check_retry_attempts</code>', '0 (off)', 'Runtime setting, 0&ndash;5.'],
      ['<code>check_retry_delay_ms</code>', '500', 'Runtime setting, 0&ndash;10000.']
    ]),

    `<h3>What may be retried</h3>
    <p>Retries are off by default and, when enabled, only ever cover a failure that could plausibly be
    transient:</p>`,

    DOCS.code(`_TRANSIENT_FAILURE_REASONS = frozenset({
    FailureReason.DNS_FAILURE.value,
    FailureReason.CONNECTION_REFUSED.value,
    FailureReason.CONNECTION_TIMEOUT.value,
    FailureReason.READ_TIMEOUT.value,
})`, 'app/monitoring/checker.py'),

    `<p>An HTTP status mismatch, a body mismatch, a TLS or certificate problem and a policy refusal are
    never retried &mdash; they are real failures of something that exists, and retrying would only
    delay reporting a fault the monitor exists to catch. A pass that only succeeded on a later attempt
    carries its <code>retry_count</code> into <code>monitoring_results</code>, so it stays visible to
    intermittent-failure detection instead of looking identical to a clean first try.</p>`,

    `<h2>Health-path discovery</h2>
    <p>Health endpoints are not standardised. The same fleet exposes Spring Boot&rsquo;s
    <code>/actuator/health</code>, Kubernetes-style <code>/healthz</code> and <code>/readyz</code>, and
    a hand-rolled <code>/health</code>; an operator adding fifty hosts at once cannot be expected to
    know which is which.</p>`,

    DOCS.diagram(`
  configured path returns 404, 405, 410 or 501
     |                    (PATH_ABSENT_STATUSES - "there is nothing here")
     |
     +-- health_path_discovery is on?   no -> report the failure as-is
     |
     v
  try health_path_candidates in order, at most 12,
  each with its own 5s timeout, expected_body_substring dropped
     |
     +-- first one that returns an expected status WINS
     |      outcome.resolved_path = that path
     |      endpoint.resolved_health_path is persisted
     |      log health_path_adopted / health_path_discovered
     |
     +-- a transport-level failure? stop - the host has stopped answering
     |   at all, and continuing would just repeat the same error
     |
     +-- nothing answered -> keep the ORIGINAL failure. "We could not find a
         health endpoint" is not evidence that the service is healthy.

  later checks go straight to the remembered path, so the 404 and the
  search are paid once rather than every interval.

  if the remembered path itself later returns one of PATH_ABSENT_STATUSES,
  it is forgotten (health_path_forgotten) and re-discovered - a service that
  moves its health endpoint should not be left permanently failing.
`, 'Only a status meaning "there is nothing at this path" starts a search. A 5xx means the application IS there and is broken; a 401/403 means the path exists behind auth. Probing alternatives in either case would turn a real failure into a false pass.'),

    `<p>The endpoint&rsquo;s own <code>url</code> is never rewritten. The discovered path is kept in a
    separate column so the operator&rsquo;s configuration is not changed behind their back, and the
    paths tried are recorded on the outcome so the adoption is visible on the endpoint detail view
    rather than being magic.</p>

    <p>Default candidates, in order: <code>/health</code>, <code>/healthz</code>,
    <code>/health/ready</code>, <code>/ready</code>, <code>/readyz</code>, <code>/live</code>,
    <code>/livez</code>, <code>/actuator/health</code>, <code>/api/health</code>,
    <code>/v1/health</code>, <code>/status</code>, <code>/ping</code>. Editable as the
    <code>health_path_candidates</code> setting; an explicitly emptied list means &ldquo;do not
    probe&rdquo;.</p>`,

    `<h2>Target safety</h2>
    <p>Two guards, both in <code>app/monitoring/validators.py</code> and the redirect hook.</p>

    <h3>Blocked addresses</h3>
    <p>After DNS resolves, the address is checked before anything is sent. Private RFC1918 space is
    <strong>explicitly allowed</strong> &mdash; monitoring internal infrastructure is the primary use
    case. Refused unless <code>ALLOW_LOOPBACK_TARGETS</code> is set:</p>`,

    DOCS.table(['Address class', 'Message'], [
      ['Loopback', '&ldquo;loopback addresses are not monitored&rdquo;'],
      ['Link-local (includes <code>169.254.169.254</code>, the cloud metadata range)',
       '&ldquo;link-local addresses (including cloud metadata) are not monitored&rdquo;'],
      ['Unspecified', '&ldquo;unspecified addresses are not monitored&rdquo;'],
      ['Multicast', '&ldquo;multicast addresses are not monitored&rdquo;'],
      ['Reserved', '&ldquo;reserved addresses are not monitored&rdquo;']
    ]),

    `<h3>Redirect hops</h3>
    <p>httpx follows redirects internally when <code>follow_redirects</code> is set, and without a
    guard none of those hops would be re-checked. A <code>response</code> event hook resolves each
    <code>Location</code> before the next request is made and aborts the chain if it points at a
    blocked address:</p>`,

    DOCS.code(`Refusing to follow redirect to <host> (<ip>): link-local addresses
(including cloud metadata) are not monitored`, 'error_message, failure_reason = blocked_target'),

    `<p>Without this, a compromised monitored host could 302 the worker into fetching a loopback or
    metadata address the endpoint itself was never allowed to target.</p>

    <h3>URL parsing</h3>
    <p><code>parse_target</code> accepts what people actually type &mdash; <code>example.com</code>,
    <code>https://api.example.com/health</code>, <code>http://10.10.10.10:8080/health</code> &mdash;
    defaulting the scheme to <code>https</code>. It rejects: an unsupported scheme (only
    <code>http</code>, <code>https</code>, <code>tcp</code>, <code>tls</code>), whitespace or control
    characters, a URL over 2048 characters, an invalid hostname, a port outside 1&ndash;65535, and
    <strong>credentials embedded in the URL</strong> &mdash; those would end up in logs and audit
    trails, so the endpoint&rsquo;s authentication fields are the supported route.</p>

    <p><code>normalise_status_codes</code> accepts <code>200</code>, <code>200,204</code>,
    <code>2xx</code> and ranges like <code>200-299</code>, expands them to an explicit sorted list,
    and rejects a range wider than 200 codes or a result longer than the 128-character column.</p>`,

    `<h2>Vantage-point confirmation</h2>
    <p>One VM, several exits. Each vantage point is a proxy the worker can reach &mdash; a Tor
    SocksPort pinned to an exit country, a VPN container exposing SOCKS &mdash; so the same check can
    leave by a different route and answer the question the local check cannot: <em>is it down, or is
    it down from here?</em></p>`,

    DOCS.diagram(`
  a check fails, and this failure is EXACTLY the one that reaches
  failure_threshold   (not the ones below it, not the ones after it)
     |
     +-- no vantages configured?           -> None, behave as before
     +-- check_type is not http?           -> skipped
     +-- hostname resolves only privately? -> skipped (an external exit
     |                                        cannot reach it by definition)
     +-- the concurrency semaphore is already full?
     |        -> skipped. NOT queued: withholding an alert because a proxy
     |           was busy would be the worst possible failure mode.
     |
     v
  probe through every proxy at once, whole round capped at
  VANTAGE_TIMEOUT_SECONDS + 5
     |
     +-- outcome up                      -> reachable
     +-- HTTP 403/407/429/451/503        -> INCONCLUSIVE (about the exit:
     |                                      blocked or throttled)
     +-- any other real HTTP status      -> agreement: the endpoint is
     |                                      serving something wrong to everyone
     +-- refused/timeout/config error    -> INCONCLUSIVE (about the proxy)
     |
     v
  at least one "reachable"?
     |
     +-- YES -> WITHHOLD the incident. Record the verdict on the endpoint
     |          (last_vantage_check, last_vantage_check_at) and log
     |          incident_withheld. The next failing check opens it.
     |
     +-- NO  -> return None. The local check opens the incident exactly as
                it would have anyway.
`, 'Three rules make this safe to build on free exits. A verdict can only WITHHOLD, never open. Inconclusive is not "down". And a vantage never contributes a timing or an uptime figure - it runs through a proxy and only on failure, so counting it would skew both.'),

    DOCS.callout('warn', 'What a vantage does not rule out',
      '<p>On a single VM the worker, the kernel, the NIC and the availability zone are still shared. ' +
      'A vantage rules out the egress path and the transit beyond it. It does not rule out the ' +
      'host.</p>'),

    `<h3>Where an exit actually comes out</h3>
    <p>The name in <code>VANTAGE_POINTS</code> is a label somebody typed, not a fact. The bundled Tor
    containers run with <code>StrictNodes 0</code> so that they fall back to another country rather
    than failing when the requested one has no exit available &mdash; the right trade for
    availability, and it means a vantage labelled &ldquo;Germany&rdquo; can quietly be answering from
    somewhere else.</p>

    <p>The <code>vantage-status</code> loop asks each proxy where its traffic comes out, every
    <code>VANTAGE_STATUS_INTERVAL_SECONDS</code> (900s), and stores the answer in
    <code>vantage_status</code>. <code>GET /api/vantage-points</code> serves it, driven by the
    configuration rather than by what has been observed, so a vantage that has never answered still
    appears &mdash; &ldquo;configured but never reached&rdquo; is the most useful thing that can be
    reported, and a missing row would render as nothing at all.</p>`,

    `<h2>Alerts</h2>`,

    DOCS.table(['Alert type', 'Default severity', 'Raised when'], [
      ['<code>endpoint_down</code>', 'critical',
       'An incident opens (or is reopened by grouping)'],
      ['<code>endpoint_recovered</code>', 'info',
       'An incident closes. <strong>Exempt from the cooldown</strong> &mdash; suppressing an ' +
       '&ldquo;all clear&rdquo; is worse than sending one too many.'],
      ['<code>high_response_time</code>', 'warning',
       'A successful check is degraded, and <code>alert_on_degraded</code> is on'],
      ['<code>repeated_failures</code>', 'critical',
       '<code>consecutive_failures</code> reaches exactly <code>failure_threshold * 4</code> &mdash; ' +
       'one escalation notice, well past the point where the first alert could have been missed'],
      ['<code>ssl_expiring</code>', 'warning (critical if the state is <code>critical</code>)',
       'A current certificate is <code>expiring_soon</code> or <code>critical</code>'],
      ['<code>ssl_expired</code>', 'critical', 'A current certificate is past its expiry'],
      ['<code>ssl_invalid</code>', 'critical', 'A current certificate failed validation']
    ]),

    `<h3>Suppression</h3>
    <p><code>raise_alert</code> returns <code>None</code> &mdash; recording nothing &mdash; when any of
    these holds:</p>

    <ol>
      <li><code>alerts_enabled</code> is off globally.</li>
      <li>The endpoint has <code>alerts_enabled = false</code>.</li>
      <li>An alert of the same type for the same endpoint was raised within
      <code>alert_cooldown_minutes</code> (default 30), and the type is not
      <code>endpoint_recovered</code>.</li>
    </ol>

    <p>An alert row is created even when <em>delivery</em> fails, so the UI still shows it and the
    failure is visible in <code>notification_status</code> and <code>notification_error</code>.</p>`,

    `<h3>Delivery</h3>`,

    DOCS.diagram(`
  alert_service.raise_alert(...)
     |
     +-- notifications_enabled off?  -> notification_status = "skipped"
     |
     v
  notification_service.dispatch_alert(session, alert)
     |
     +-- load every enabled channel
     +-- channel_matches(): severity >= min_severity, alert_type in
     |   event_types (empty = all), environment in environment_filter,
     |   at least one tag in tag_filter
     |
     +-- no channel matched -> notification_status = "skipped"
     |
     +-- for each matching channel:
     |      decrypt the config  (Fernet blob)
     |      deliver, up to MAX_ATTEMPTS = 3 with 2s / 4s backoff,
     |      15s timeout per attempt
     |      update channel success_count / failure_count / last_error
     |
     +-- all delivered -> "sent"
         some delivered -> "partial"
         none delivered -> "failed"    (+ notification_error)
`, 'dispatch_alert never raises: a failed notification must not roll back the monitoring result that produced it.'),

    DOCS.table(['Channel', 'Required config', 'Notes'], [
      ['<code>webhook</code>', '<code>url</code>',
       'Method POST/PUT/PATCH. With a <code>secret</code>, the body is signed HMAC-SHA256 and sent ' +
       'as <code>X-InfraSight-Signature: sha256=...</code> and, for compatibility, ' +
       '<code>X-CertMonitor-Signature</code> with the same value.'],
      ['<code>slack</code>', '<code>webhook_url</code>',
       'Block Kit: a header naming the event, the endpoint linked to its monitored URL, a ' +
       'two-column field grid, an optional <em>Open in InfraSight</em> button when ' +
       '<code>public_base_url</code> is set, and a context line whose timestamp Slack renders in ' +
       'each reader&rsquo;s own timezone. The severity colour bar comes from a single-attachment ' +
       'wrapper.'],
      ['<code>teams</code>', '<code>webhook_url</code>', 'MessageCard with a severity theme colour'],
      ['<code>pagerduty</code>', '<code>routing_key</code>', 'Events v2 payload'],
      ['<code>email</code>', '<code>host</code>, <code>from_address</code>, <code>recipients</code>',
       'Port defaults to 587, <code>use_tls</code> true. SMTP send runs off the event loop.']
    ]),

    DOCS.callout('tip', 'Secrets in channel configuration',
      '<p>The whole provider config is stored as one Fernet-encrypted blob in ' +
      '<code>config_encrypted</code>. <code>config_public</code> holds only what is safe to display ' +
      'back: for a webhook that is the target host and scheme, the method, the names (not values) of ' +
      'custom headers, and whether signing is enabled. A webhook URL, an SMTP password and a ' +
      'PagerDuty routing key are never returned by the API.</p>')

  ].join('\n')
});
