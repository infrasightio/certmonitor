DOCS.page({
  id: 'incidents',
  title: 'Incidents and alerts',
  description: 'How an outage becomes one incident record, what that record carries, and how alerts are raised, suppressed and acknowledged.',
  body: [

    `<h2>One incident per continuous outage</h2>
    <p>An incident is not a failed check. It is the record of a period during which an endpoint was
    down, however many checks failed inside it &mdash; <code>failed_check_count</code> reports that
    number.</p>`,

    DOCS.callout('tip', 'Enforced by the database, not by hoping',
      '<p>A partial unique index, <code>uq_incidents_one_open_per_endpoint</code> on ' +
      '<code>endpoint_id WHERE status = \'open\'</code>, allows at most one open incident per ' +
      'endpoint. Two workers racing to open one cannot both succeed: the loser catches the ' +
      '<code>IntegrityError</code>, adopts the winner&rsquo;s row, and logs ' +
      '<code>incident_open_race_resolved</code>. Because the insert happens inside a ' +
      '<code>SAVEPOINT</code>, the monitoring result written earlier in the same transaction ' +
      'survives.</p>'),

    `<h2>Lifecycle</h2>`,

    DOCS.diagram(`
    checks failing, consecutive_failures climbing
                    |
                    |  reaches failure_threshold
                    v
         +----------------------+
         |   vantage gate?      |  only if vantages are configured, and only
         |                      |  on this exact check
         +----+------------+----+
              |            |
    reachable |            | not reachable / inconclusive / skipped
    elsewhere |            |
              v            v
      withhold, record   +-------------------------------------+
      the reason, no     |  a RESOLVED incident on this        |
      incident yet       |  endpoint inside                    |
      (no second         |  incident_grouping_minutes,         |
       reprieve on the   |  with NO RCA attached?              |
       next failure)     +----+---------------------------+----+
                              | yes                       | no
                              v                           v
                          REOPEN it                   OPEN a new one
                          status = open               status = open
                          resolved_at = NULL          severity = critical
                          + "reopened" entry          started_at = checked_at
                              |                           |
                              +-------------+-------------+
                                            |
                                   raise endpoint_down
                                            |
                          +-----------------v------------------+
                          |            status = open           |
                          |  each further failure:             |
                          |    failed_check_count += 1         |
                          |    reason changed? append a        |
                          |    "reason_changed" entry          |
                          |    (no new alert)                  |
                          +-----------------+------------------+
                                            |
                        consecutive_successes >= recovery_threshold
                                            v
                          +------------------------------------+
                          |          status = resolved         |
                          |  resolved_at, duration_seconds,    |
                          |  recovery_status_code,             |
                          |  recovery_response_time_ms,        |
                          |  + "resolved" entry                |
                          +------------------------------------+
                                            |
                                  raise endpoint_recovered
`, 'recovery_threshold defaults to 1, and is a runtime setting - raise it to guard against a flapping endpoint closing incidents too early.'),

    `<h2>What an incident record holds</h2>`,

    DOCS.table(['Field', 'Content'], [
      ['<code>status</code>', '<code>open</code> or <code>resolved</code>'],
      ['<code>severity</code>', '<code>critical</code> for an automatically opened incident'],
      ['<code>started_at</code>', 'The <code>checked_at</code> of the failing check that opened it'],
      ['<code>resolved_at</code>, <code>duration_seconds</code>', 'Set on recovery'],
      ['<code>reason</code>', 'The <code>failure_reason</code> at the time, updated if it changes'],
      ['<code>error_message</code>, <code>first_failure_status_code</code>',
       'The detail from the check that opened it'],
      ['<code>failed_check_count</code>', 'How many checks failed inside this outage'],
      ['<code>recovery_status_code</code>, <code>recovery_response_time_ms</code>',
       'What the endpoint answered with when it came back'],
      ['<code>timeline</code>',
       'JSON entries of <code>{at, kind, detail}</code>. Kinds written automatically: ' +
       '<code>opened</code>, <code>reopened</code>, <code>reason_changed</code>, ' +
       '<code>resolved</code>. Detail is truncated to 500 characters, and the list is capped at the ' +
       'last 50 entries.'],
      ['<code>acknowledged_by_id</code>, <code>acknowledged_at</code>, <code>notes</code>',
       'Operator annotation, via <code>PATCH /api/incidents/{id}</code>']
    ]),

    `<h2>Incident grouping</h2>
    <p><code>incident_grouping_minutes</code> (default 15) exists so a flap &mdash; down, briefly
    recovers, down again &mdash; reads as one problem instead of a wall of separate incidents and
    duplicate alerts.</p>

    <p>Only a <em>resolved</em> incident with <strong>no RCA</strong> is eligible for regrouping. One
    that has already been written up should not silently be extended with a second, unrelated
    occurrence&rsquo;s data underneath its owner&rsquo;s back.</p>`,

    `<h2>Comments</h2>
    <p><code>incident_comments</code> is a plain conversation attached to an incident: &ldquo;started
    right after the deploy&rdquo;, &ldquo;rollback done&rdquo;, &ldquo;connections were
    exhausted&rdquo;.</p>

    <p>That conversation is the raw material of the RCA. Keeping it on the incident rather than in
    chat means the RCA owner inherits it instead of reconstructing it &mdash; and
    <code>rca_draft.gather_evidence</code> reads it directly when assembling a draft.</p>`,

    `<h2>Querying incidents</h2>
    <p><code>GET /api/incidents</code> is paginated and newest-first by default, with these filters:</p>`,

    DOCS.table(['Parameter', 'Accepts'], [
      ['<code>endpoint_id</code>', 'One UUID'],
      ['<code>status</code>', '<code>open</code>, <code>resolved</code>; repeatable or comma-separated'],
      ['<code>severity</code>', 'Repeatable or comma-separated'],
      ['<code>reason</code>', 'Any <code>failure_reason</code> value'],
      ['<code>environment</code>, <code>tag</code>', 'UUIDs, joined through the endpoint'],
      ['<code>since</code>, <code>until</code>', 'ISO timestamps, applied to <code>started_at</code>'],
      ['<code>min_duration_seconds</code>',
       'Excludes incidents shorter than this, and anything unresolved'],
      ['<code>search</code>', 'Endpoint name, endpoint URL or the incident error message'],
      ['<code>sort_dir</code>', '<code>asc</code> or <code>desc</code> on <code>started_at</code>']
    ]),

    `<h2>Alerts</h2>
    <p>An alert is a notification-worthy event. It always produces a row, even when delivery fails, so
    the UI shows it and the failure is visible.</p>`,

    DOCS.table(['Field', 'Content'], [
      ['<code>alert_type</code>, <code>severity</code>, <code>title</code>, <code>message</code>',
       'The event itself'],
      ['<code>details</code>',
       'A JSON payload specific to the type &mdash; failure reason, consecutive failures, incident ' +
       'id, response time, certificate days remaining, issuer'],
      ['<code>endpoint_id</code>, <code>incident_id</code>', 'Cross-links, both nullable'],
      ['<code>notification_status</code>',
       '<code>pending</code> &rarr; <code>sent</code> | <code>partial</code> | <code>failed</code> | ' +
       '<code>skipped</code>'],
      ['<code>notification_attempts</code>, <code>notification_error</code>, <code>notified_at</code>',
       'Delivery bookkeeping'],
      ['<code>is_acknowledged</code>, <code>acknowledged_by_id</code>, <code>acknowledged_at</code>',
       'Set by <code>POST /api/alerts/acknowledge</code>, which takes a list of ids']
    ]),

    `<h3>Suppression rules, in order</h3>
    <ol>
      <li><code>alerts_enabled</code> off globally &rarr; nothing is raised at all.</li>
      <li>The endpoint has <code>alerts_enabled = false</code> &rarr; nothing is raised for it.</li>
      <li>An alert of the same type for the same endpoint exists within
      <code>alert_cooldown_minutes</code> &rarr; suppressed, logged at debug as
      <code>alert_suppressed_by_cooldown</code>.</li>
      <li><code>endpoint_recovered</code> is exempt from rule 3. Suppressing an &ldquo;all
      clear&rdquo; is worse than sending one too many.</li>
      <li><code>notifications_enabled</code> off &rarr; the alert row is still written, marked
      <code>skipped</code>, and nothing is dispatched.</li>
    </ol>

    <p>Acknowledged alerts older than <code>alert_retention_days</code> (default 180) are deleted by
    the retention sweep. Incidents are kept for <code>incident_retention_days</code> (default 730) and
    only when resolved &mdash; an open incident is current state, not history.</p>`,

    `<h2>Notification channels</h2>
    <p>Managed under Settings, requiring <code>notification:write</code> to create, edit, test or
    delete. Each channel has four independent filters, all of which must pass:</p>`,

    DOCS.table(['Filter', 'Empty means'], [
      ['<code>min_severity</code>', 'Defaults to <code>warning</code>. Ordering: info &lt; warning &lt; critical.'],
      ['<code>event_types</code>', 'All alert types'],
      ['<code>environment_filter</code>',
       'All environments. Holds environment <strong>names</strong>, not UUIDs.'],
      ['<code>tag_filter</code>',
       'All endpoints. Holds tag <strong>names</strong>; when set, the endpoint must carry at least ' +
       'one of them.']
    ]),

    `<p><code>POST /api/notification-channels/{id}/test</code> delivers a synthetic payload so a
    channel can be verified without waiting for a real outage.</p>

    <h3>Delivery counters</h3>
    <p>Each channel accumulates <code>success_count</code>, <code>failure_count</code> and
    <code>last_error</code>. They are lifetime totals, not a rate, so a channel that was
    misconfigured for an afternoon carries those failures forever.</p>

    <p><strong>Replacing a channel&rsquo;s configuration resets all three.</strong> The counters
    describe the configuration that was just replaced &mdash; a channel that failed thirteen times
    against a mistyped SMTP port should not keep reading as unhealthy once the port is corrected.
    Updating only the filters (severity, events, environments, tags) leaves the counters alone,
    because the delivery target has not changed.</p>`,

    DOCS.callout('note', 'Delivery is retried, but never at the cost of the check',
      '<p>Each channel gets up to three attempts with exponential backoff (2s, then 4s, capped at ' +
      '8s) and a 15-second timeout per attempt, so a transient 502 from a webhook receiver does not ' +
      'lose the alert. <code>dispatch_alert</code> never raises: a failed notification must not roll ' +
      'back the monitoring result that produced it.</p>')

  ].join('\n')
});
