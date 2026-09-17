DOCS.page({
  id: 'endpoints',
  title: 'Endpoints',
  description: 'Configuring what is monitored: fields, grouping, thresholds, pausing, dependencies, captures and bulk import.',
  body: [

    `<h2>What an endpoint is</h2>
    <p>One row in <code>endpoints</code>, one thing being watched. Creating one parses the URL once at
    write time into <code>protocol</code>, <code>hostname</code>, <code>port</code> and
    <code>path</code>, so the SSL page and every filter can query on host without re-parsing thousands
    of URLs per request.</p>

    <p>A new endpoint is scheduled immediately &mdash; <code>next_check_at</code> is set to now rather
    than one interval ahead &mdash; so its first real status appears within one worker poll.</p>`,

    `<h2>Configuration fields</h2>`,

    DOCS.tabs([
      {
        label: 'Identity',
        html: DOCS.table(['Field', 'Rules', 'Notes'], [
          ['<code>name</code>', 'Required, 1&ndash;160 chars', 'Indexed; searched by the list filter'],
          ['<code>url</code>', 'Required, up to 2048 chars',
           'Normalised by <code>parse_target</code>. Scheme defaults to <code>https</code>. ' +
           'Credentials in the URL are rejected.'],
          ['<code>check_type</code>', '<code>http</code> | <code>tcp</code> | <code>tls</code>', 'Default <code>http</code>'],
          ['<code>http_method</code>', 'Normalised, uppercase', 'Default <code>GET</code>'],
          ['<code>port</code>', '1&ndash;65535', 'Taken from the URL when omitted: 80 for http, 443 for the rest'],
          ['<code>description</code>', 'Free text', '']
        ])
      },
      {
        label: 'Ownership',
        html: DOCS.table(['Field', 'Rules', 'Notes'], [
          ['<code>owner</code>', 'Up to 128 chars, indexed',
           'The contact handle people actually type &mdash; almost always an e-mail'],
          ['<code>owner_name</code>', 'Up to 128 chars',
           'Who that contact <em>is</em>, so a screen can show a person rather than an address and ' +
           'still keep the address to contact them by'],
          ['<code>team</code>', 'Up to 128 chars, indexed',
           'Free-text label. The same convention is used on users and on RCA ownership &mdash; there ' +
           'is no team table.'],
          ['<code>application</code>', 'Up to 128 chars, indexed',
           'Groups endpoints for blast-radius analysis in Diagnose, and links them to changes'],
          ['<code>master_node_ip</code>', 'Up to 128 chars, free text',
           'Where the service is hosted, for whoever has to go and look. Deliberately not validated ' +
           'as an address: refusing <code>10.0.1.4 (prod-master-1)</code> would only push it into ' +
           'the description.']
        ])
      },
      {
        label: 'Check behaviour',
        html: DOCS.table(['Field', 'Rules', 'Notes'], [
          ['<code>interval_seconds</code>', '10&ndash;86400 in the schema',
           'Then clamped server-side to <code>MIN_MONITOR_INTERVAL</code>&hellip;' +
           '<code>MAX_MONITOR_INTERVAL</code>. The <em>effective</em> cadence can still be shorter ' +
           '&mdash; see <a href="#/monitoring#check-cadence">check cadence</a>.'],
          ['<code>timeout_seconds</code>', '1&ndash;120',
           'Additionally clamped to no more than the interval'],
          ['<code>expected_status_codes</code>', 'Up to 128 chars',
           'Accepts <code>200</code>, <code>200,204</code>, <code>2xx</code>, <code>200-299</code>. ' +
           'Expanded and stored as an explicit sorted list.'],
          ['<code>expected_body_substring</code>', 'Up to 255 chars',
           'Matched against the first 64&nbsp;KB of the response. Absent substring = a ' +
           '<code>down</code> check with <code>http_status_mismatch</code>.'],
          ['<code>request_body</code>', 'Up to 64000 chars', 'Sent as UTF-8'],
          ['<code>custom_headers</code>', 'Object of strings',
           'Non-sensitive headers only &mdash; authentication material belongs in the auth fields'],
          ['<code>follow_redirects</code>', 'Boolean, default true',
           'Every hop is re-checked against the blocked-address policy'],
          ['<code>verify_ssl</code>', 'Boolean, default true',
           'Off means the chain is not verified and <code>chain_verified</code> is recorded as ' +
           'unknown'],
          ['<code>ssl_monitoring_enabled</code>', 'Boolean, default true',
           'Effective only when the protocol is https']
        ])
      },
      {
        label: 'Authentication',
        html: DOCS.table(['Field', 'Used when', 'Notes'], [
          ['<code>auth_type</code>', 'Always',
           '<code>none</code> | <code>bearer</code> | <code>basic</code> | <code>header</code>'],
          ['<code>auth_username</code>', '<code>basic</code>', ''],
          ['<code>auth_header_name</code>', '<code>header</code>', 'The header name to set'],
          ['<code>auth_secret</code>', 'All but <code>none</code>',
           'Up to 4096 chars. Fernet-encrypted into <code>auth_secret_encrypted</code> and ' +
           '<strong>never returned by the API</strong>. On update, omitting it keeps the stored ' +
           'value; sending <code>auth_type: "none"</code> clears it.'],
          ['<code>auth_secret_hint</code>', 'Read-only', 'A mask such as <code>****abcd</code>']
        ])
      },
      {
        label: 'Thresholds',
        html:
          `<p>Every one of these is nullable, and null means <em>inherit</em>. The read payload
          also reports the resolved value as
          <code>effective_&lt;field&gt;</code>, so a screen can show the number in force while an
          edit form still binds to the override &mdash; prefilling the inherited value and saving it
          back would silently pin it.</p>

          <p><strong>Before 0018</strong> this was true of three of the four.
          <code>failure_threshold</code> was NOT NULL with a default, and endpoint creation resolved
          the global setting onto the row, so resolution always stopped at the first tier and an
          environment-level or global failure threshold could never apply. Migration 0018 drops the
          NOT NULL. Existing rows keep the explicit value they already carry, so no deployment's
          alerting shifts on upgrade &mdash; clearing the field is how an endpoint opts in.</p>` +
          DOCS.table(['Field', 'Range', 'Falls back to'], [
            ['<code>failure_threshold</code>', '1&ndash;20',
             'Environment override, then the <code>failure_threshold</code> setting, then 3'],
            ['<code>response_time_threshold_ms</code>', '1&ndash;600000',
             'Environment override, then <code>response_time_threshold_ms</code>, then 2000'],
            ['<code>ssl_warning_days</code>', '1&ndash;365',
             'Environment override, then <code>ssl_warning_days</code>, then 30'],
            ['<code>ssl_critical_days</code>', '1&ndash;180',
             'Environment override, then <code>ssl_critical_days</code>, then 7'],
            ['<code>alerts_enabled</code>', 'Boolean, default true',
             'A per-endpoint mute. <code>raise_alert</code> returns None for this endpoint entirely.']
          ])
      }
    ]),

    `<h2>Threshold resolution</h2>`,

    DOCS.diagram(`
  endpoint.<field> is not NULL ?          -> use it
            |
            no
            v
  endpoint.environment.<field> is not NULL ?   -> use it
            |
            no
            v
  runtime setting (system_settings row)   -> use it
            |
            missing
            v
  built-in default
`, 'A team can set a laxer failure threshold for all of staging without touching every endpoint in it, while one noisy endpoint can still override that environment default for itself.'),

    `<h2>Grouping</h2>

    <h3>Environments</h3>
    <p>Rows in <code>environments</code>, not an enum, so teams can add their own. Five are seeded on
    first boot &mdash; and only when the table is empty, because a team that deleted
    &ldquo;staging&rdquo; should not have it reappear on restart:</p>`,

    DOCS.table(['Name', 'Display', 'Colour', 'Sort order'], [
      ['<code>development</code>', 'Development', '<code>#3b82f6</code>', '10'],
      ['<code>testing</code>', 'Testing', '<code>#8b5cf6</code>', '20'],
      ['<code>staging</code>', 'Staging', '<code>#f59e0b</code>', '30'],
      ['<code>production</code>', 'Production', '<code>#ef4444</code>', '40'],
      ['<code>other</code>', 'Other', '<code>#6b7280</code>', '90']
    ]),

    `<p>An environment carries four optional threshold overrides
    (<code>failure_threshold</code>, <code>ssl_warning_days</code>, <code>ssl_critical_days</code>,
    <code>response_time_threshold_ms</code>) and is referenced by name in two settings that change
    behaviour:</p>

    <ul>
      <li><code>fast_check_environments</code> &mdash; endpoints here are checked at
      <code>fast_check_interval</code> whether or not they are failing.</li>
      <li><code>change_approval_environments</code> &mdash; a change targeting one of these must be
      approved before it can be deployed.</li>
    </ul>

    <p>Deleting an environment sets <code>environment_id</code> to NULL on its endpoints
    (<code>ON DELETE SET NULL</code>); the API requires <code>?force=true</code> when endpoints are
    still attached.</p>

    <h3>Tags</h3>
    <p>A many-to-many through <code>endpoint_tags</code>, with a unique name, an optional colour and an
    optional description. Up to 20 per endpoint. Tags are a filter dimension on the endpoint list, the
    dashboard and notification-channel routing, and one of the three groupings the dashboard reports
    availability by (environment, tag, team).</p>

    <h3>Dependencies</h3>
    <p>A self-referential many-to-many through <code>endpoint_dependencies</code>, with a check
    constraint forbidding self-reference. Up to 20 per endpoint. Purely declarative: nothing about
    scheduling or status changes, but Diagnose reads it to correlate a failure with a declared
    dependency also being down. The ORM relationship is <code>viewonly</code>; writes go through the
    association table directly in <code>endpoint_service</code>, which keeps the self-referential
    many-to-many simple rather than fighting cascade rules.</p>`,

    `<h2>Pausing and disabling</h2>
    <p>Two different switches, and an attributed reason.</p>`,

    DOCS.table(['Field', 'Set by', 'Effect'], [
      ['<code>monitoring_enabled = false</code>',
       'An operator, via <code>PATCH /api/endpoints/{id}/monitoring</code> or a bulk action',
       'Permanently excluded from the claim query'],
      ['<code>is_paused = true</code>',
       'An operator, or the start of a deployment',
       'Temporarily excluded from the claim query'],
      ['<code>pause_reason</code>', 'Whoever paused it',
       'Free text, or <code>Deployment CHG-YYYY-NNNN</code> when a change paused it'],
      ['<code>paused_by_change_id</code>', 'Only the deployment path',
       'The attribution that makes resume safe']
    ]),

    `<p>In either state <code>next_check_at</code> is cleared and <code>current_status</code> becomes
    <code>paused</code>: a paused endpoint keeps its history but must not be read as healthy or
    failing while nothing is checking it. On resume, <code>next_check_at</code> is set to now, the
    lease is cleared, the pause reason is cleared and the status returns to
    <code>unknown</code>.</p>`,

    DOCS.callout('warn', 'A manual pause takes ownership',
      '<p>Pausing an endpoint manually sets <code>paused_by_change_id</code> to NULL, so completing ' +
      'whatever deployment paused it earlier no longer resumes it behind the operator. Conversely, ' +
      'a deployment only resumes the endpoints it actually paused: the ' +
      '<code>change_endpoints.was_paused_before</code> flag records what it found, and an endpoint ' +
      'that was already paused stays paused.</p>'),

    `<h2>Bulk actions</h2>
    <p><code>POST /api/endpoints/bulk</code> takes a list of ids and one action. Requires
    <code>endpoint:write</code>, with two extra checks made inside the handler so the other actions
    stay available to any endpoint editor.</p>`,

    DOCS.table(['Action', 'Extra permission', 'Does'], [
      ['<code>enable</code>', '&mdash;',
       'Enables and unpauses, clears the pause reason, schedules immediately'],
      ['<code>disable</code>', '&mdash;',
       'Disables, clears <code>next_check_at</code>, status becomes <code>paused</code>'],
      ['<code>pause</code>', '&mdash;', 'Pauses, with the supplied <code>pause_reason</code>'],
      ['<code>resume</code>', '&mdash;', 'Unpauses and enables, schedules immediately'],
      ['<code>check</code>', '<code>endpoint:check</code>',
       'Marks each endpoint due immediately, so the worker picks them up on its next poll rather ' +
       'than the API running hundreds of probes inline'],
      ['<code>tag</code> / <code>untag</code>', '&mdash;', 'Adds or removes the supplied tags'],
      ['<code>delete</code>', '<code>endpoint:delete</code>',
       'Deletes, cascading results, certificates, incidents and captures']
    ]),

    `<p>The result is a <code>BulkActionResult</code> carrying a success count and a per-id error list,
    so a partial failure is reported rather than swallowed.</p>`,

    `<h2 id="captures">Captures</h2>
    <p>What the endpoint actually returned, the last time it passed and the last time it failed.
    <strong>Two rows per endpoint, ever.</strong></p>`,

    DOCS.callout('tip', 'The pair is the storage policy',
      '<p>The primary key is <code>(endpoint_id, outcome)</code> with <code>outcome</code> ' +
      'constrained to <code>success</code> or <code>failure</code>, so writing a new capture ' +
      '<em>replaces</em> the old one. That is not a retention policy someone has to remember to run ' +
      '&mdash; the table cannot grow with check volume the way ' +
      '<code>monitoring_results</code> does, and deleting the endpoint takes both rows with it.</p>'),

    DOCS.table(['Stored', 'Detail'], [
      ['The check that produced it',
       'Status, HTTP code, failure reason, error message, response time, final URL, captured-by and ' +
       'captured-at'],
      ['The body',
       'Text only, truncated to 16000 characters. <code>body_bytes</code> records the length of the ' +
       '<em>full</em> response, so the panel can say &ldquo;showing the first 64&nbsp;KB of ' +
       '2.1&nbsp;MB&rdquo; rather than implying the response was small. Binary responses (images, ' +
       'PDFs, protobuf, gzip) are not stored at all; the metadata row still records what the type ' +
       'was.'],
      ['Response headers', 'The same allow-list the result row keeps'],
      ['The screenshot',
       'Optional and opt-in per endpoint. Deferred in the ORM, so the detail panel reads the body and ' +
       'metadata without dragging a hundred kilobytes of JPEG through that query. Served by its own ' +
       'route with an ETag.']
    ]),

    `<p>A <strong>degraded</strong> check counts as a success here: the endpoint answered, and what it
    answered with is what the capture is for.</p>

    <h3>Screenshots</h3>
    <p>Three gates, cheapest first: <code>SCREENSHOT_ENABLED</code> fleet-wide, then
    <code>endpoint.screenshot_enabled</code>, then <code>check_type == http</code> &mdash; there is
    nothing to photograph about a TCP handshake.</p>

    <p>The render runs <em>after</em> the check has been recorded and committed, as a tracked
    background task, under its own semaphore (<code>SCREENSHOT_CONCURRENCY</code>, default 2) that is
    deliberately far below <code>WORKER_CONCURRENCY</code>: 50 concurrent HTTP checks is nothing, 50
    concurrent Chromium pages is several gigabytes. One browser process is shared for the lifetime of
    the worker. Every failure is swallowed and recorded as <code>image_error</code> &mdash; a render
    that fails is worth saying out loud, because silently showing nothing looks like the feature is
    broken rather than like the page is.</p>`,

    `<h2>Bulk import and export</h2>

    <h3>Import</h3>
    <p>CSV or Excel, validate-then-confirm. The template columns, in order:</p>`,

    DOCS.code(`name, url, environment, tags, interval, timeout, description,
owner, owner_name, team, application, master_node_ip, method,
expected_status, check_type, monitoring_enabled, ssl_monitoring,
verify_ssl, follow_redirects, failure_threshold, response_time_threshold_ms`,
      'GET /api/import/template'),

    `<p>Only <code>url</code> is truly required &mdash; a file without a recognisable URL column is
    rejected outright. Header spellings are normalised through an alias map, so
    <code>endpoint_name</code>, <code>endpoint</code> and <code>name</code> all land on the same field,
    as do <code>host</code>, <code>target</code>, <code>address</code> and <code>url</code>.</p>

    <p>Rows are numbered from 2, matching what the operator sees in their spreadsheet. The preview
    reports per-row errors, per-row warnings, and duplicates &mdash; both against the database and
    <em>within the file</em>. Nothing is written during analysis, so a bad file cannot leave half an
    import behind. On confirm, each row is created inside its own <code>SAVEPOINT</code>, so one late
    failure does not discard the rows that already succeeded.</p>`,

    DOCS.table(['Limit', 'Value', 'Set by'], [
      ['Rows per file', '5000', '<code>MAX_IMPORT_ROWS</code>'],
      ['Upload size', '10&nbsp;MB', '<code>MAX_UPLOAD_BYTES</code> (nginx allows 12&nbsp;MB, so the ' +
       'API produces the error rather than the proxy)'],
      ['Preview lifetime', '15 minutes', '<code>preview_store.TTL_SECONDS</code>']
    ]),

    `<h3>Export</h3>
    <p><code>GET /api/export</code> returns the current configuration as CSV or Excel, honouring the
    same filters as the endpoint list. It requires <code>endpoint:export</code> &mdash; which
    <em>viewers hold</em> &mdash; and writes an <code>endpoints_exported</code> audit entry.</p>`,

    DOCS.callout('note', 'Export never contains secrets',
      '<p>The export columns are configuration and current state. <code>auth_secret_encrypted</code> ' +
      'is not among them, so a round-trip through export and import requires re-entering any ' +
      'endpoint credential.</p>')

  ].join('\n')
});
