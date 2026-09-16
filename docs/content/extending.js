DOCS.page({
  id: 'extending',
  title: 'Maintaining and extending',
  description: 'The conventions a change has to respect, recipes for the common extensions, and how to keep these docs true.',
  body: [

    `<h2>Conventions worth respecting</h2>`,

    DOCS.table(['Rule', 'Why it exists'], [
      ['<strong>Routes stay thin.</strong> Validate, call a service, audit, commit, serialise.',
       'Business logic in a handler cannot be reused by the worker, and cannot be tested without ' +
       'an HTTP client.'],
      ['<strong><code>app/monitoring/</code> never imports from <code>app/services/</code>.</strong>',
       'That one-way dependency is what lets the same probe run from the worker, from a manual ' +
       'check, and from a test with no database.'],
      ['<strong>Only <code>record_check_result</code> writes check state.</strong>',
       'One writer means the worker and the API cannot disagree about what a check means.'],
      ['<strong>Enums are short strings, not PostgreSQL <code>ENUM</code> types.</strong>',
       'Adding a value is a code change instead of a migration that has to mutate a type under ' +
       'load.'],
      ['<strong>Every administrative mutation calls <code>audit_service.record</code>.</strong>',
       'Consistency, and it is impossible to forget in a handler if it is the convention.'],
      ['<strong>Models carry dialect variants.</strong> <code>JSONType</code>, ' +
       '<code>BigIntType</code>.',
       'The test suite runs on SQLite. Break this and the suite stops being runnable without ' +
       'services.'],
      ['<strong>Nothing is executed on a monitored host.</strong>',
       'InfraSight observes. There is no remediation path, and adding one would change what the ' +
       'product is.'],
      ['<strong>Secrets are encrypted and never serialised back.</strong>',
       'Return a hint or a public view, never the value.']
    ]),

    `<h2>Common extensions</h2>`,

    DOCS.details('Add a runtime setting',
      `<ol>
        <li>Append a <code>SettingSpec</code> to <code>SETTING_SPECS</code> in
        <code>app/services/settings_service.py</code>, with its key, type, default, category, label,
        description and bounds.</li>
        <li>Read it wherever it applies, via the <code>config</code> dict that services already
        receive.</li>
        <li>Nothing else. <code>ensure_seeded</code> inserts the row on the next boot,
        <code>validate_value</code> enforces the bounds, and the Settings page renders it from the
        spec &mdash; there is no separate UI to update.</li>
      </ol>` +
      DOCS.callout('warn', 'No migration, but do think about the default',
        '<p>An existing deployment gets the default on its next start. Choose one that preserves ' +
        'current behaviour, the way both feature flags default to on.</p>')),

    DOCS.details('Add a failure reason',
      `<ol>
        <li>Add the value to <code>FailureReason</code> in <code>app/core/enums.py</code>.</li>
        <li>Add a human label to <code>_HUMAN_REASONS</code> in
        <code>app/services/monitoring_service.py</code>, or
        <code>humanise_reason</code> will fall back to title-casing the key.</li>
        <li>Classify it in <code>_classify_httpx_error</code> or wherever it is detected.</li>
        <li>Decide whether it belongs in <code>_TRANSIENT_FAILURE_REASONS</code> &mdash; only if a
        retry could plausibly fix it.</li>
        <li>Consider what Diagnose should say about it in
        <code>app/services/diagnosis_reasoning.py</code>.</li>
      </ol>
      <p>No migration: the column is a string.</p>`),

    DOCS.details('Add a notification channel type',
      `<ol>
        <li>Add the value to <code>NotificationChannelType</code>.</li>
        <li>Add its required keys to <code>REQUIRED_CONFIG</code> and its secret keys to
        <code>_SECRET_KEYS_BY_TYPE</code> in <code>notification_service.py</code>.</li>
        <li>Extend <code>validate_config</code> with any type-specific normalisation, and
        <code>public_view</code> with what is safe to show back.</li>
        <li>Write an <code>async def _deliver_&lt;type&gt;(config, payload)</code> that raises
        <code>NotificationError</code> on failure, and register it in <code>_DELIVERY</code>.</li>
      </ol>
      <p>Retries, backoff, filtering and bookkeeping are handled by
      <code>deliver_to_channel</code> and <code>dispatch_alert</code> &mdash; the handler only has
      to deliver or raise.</p>`),

    DOCS.details('Add a check type',
      `<p>The heaviest of these, because it touches the probe.</p>
      <ol>
        <li>Add the value to <code>CheckType</code>.</li>
        <li>Write <code>async def _run_&lt;type&gt;_check(target, outcome)</code> in
        <code>checker.py</code>, setting <code>status</code>, <code>failure_reason</code>,
        <code>error_message</code> and whatever timings apply.</li>
        <li>Dispatch to it in <code>_run_check_once</code>, after the DNS and blocked-address
        stages.</li>
        <li>Decide whether it participates in certificate inspection, health-path discovery,
        screenshots and vantage confirmation &mdash; all four are currently gated on
        <code>check_type == http</code>.</li>
        <li>Accept the value in <code>_normalise_check_type</code> in the endpoint schema.</li>
      </ol>`),

    DOCS.details('Add a permission',
      `<ol>
        <li>Add the code to <code>Permission</code> in <code>app/core/enums.py</code>.</li>
        <li>Grant it to the roles that should hold it in <code>ROLE_PERMISSIONS</code>.</li>
        <li>Add a named gate in <code>app/api/deps.py</code> and apply it to the routes.</li>
        <li>Use it in the SPA through <code>can(\'your:code\')</code> to hide controls.</li>
      </ol>` +
      DOCS.callout('tip', 'No migration needed',
        '<p><code>ensure_roles</code> is additive and idempotent: it creates the permission row and ' +
        'grants it to its roles on the next boot. That is why the seeding step runs every start ' +
        'rather than only on first install.</p>')),

    DOCS.details('Add a database column',
      DOCS.code(`cd backend
alembic revision -m "what it is for"
# edit the generated file - upgrade() and downgrade()
alembic upgrade head`, 'shell') +
      `<ol>
        <li>Add the column to the model.</li>
        <li>Write the migration by hand, or check an autogenerated one carefully. The naming
        convention keeps the diff clean.</li>
        <li>Chain it: set <code>down_revision</code> to the current head
        (<code>0017</code> at the time of writing). The chain is linear and should stay that
        way.</li>
        <li>Add the field to the relevant Pydantic schemas &mdash; the API contract is separate from
        the model on purpose.</li>
      </ol>` +
      DOCS.callout('warn', 'Nullable, or with a server default',
        '<p>Migrations run against a live database while the previous version may still be serving. ' +
        'A non-nullable column with no default will fail on any table with rows.</p>')),

    DOCS.details('Add a screen to the SPA',
      `<ol>
        <li>Create the page under <code>frontend/src/pages/</code>.</li>
        <li>Add a <code>React.lazy</code> import and a <code>Route</code> in
        <code>App.jsx</code>, wrapped in <code>RequirePermission</code> and, if it belongs to an
        optional module, <code>RequireFeature</code>.</li>
        <li>Add the API calls to the matching object in <code>src/lib/api.js</code> rather than
        calling axios from the component.</li>
        <li>Add the navigation entry in <code>src/components/menu.jsx</code>.</li>
        <li>Use <code>useAutoRefresh</code> for anything that goes stale, passing
        <code>paused</code> while the user is editing.</li>
      </ol>`),

    `<h2>Testing</h2>
    <p>About 500 tests across 18 modules, running against a throwaway SQLite file &mdash; no
    PostgreSQL, no Redis, no network.</p>`,

    DOCS.table(['Module', 'Covers'], [
      ['<code>test_checker.py</code> (39)', 'Probe behaviour, error classification, retries, discovery'],
      ['<code>test_monitoring_state.py</code> (41)',
       'Status transitions, incident open/close/regroup, alert generation'],
      ['<code>test_endpoints_api.py</code> (48)', 'Endpoint CRUD, filtering, bulk actions'],
      ['<code>test_rca.py</code> (48)', 'The RCA workflow, ownership and permissions'],
      ['<code>test_health_and_settings.py</code> (53)', 'Probes, settings validation, worker status'],
      ['<code>test_auth.py</code> (40)', 'Sign-in, lockout, rate limiting, token versioning'],
      ['<code>test_changes.py</code> (33)', 'The change state machine and pause attribution'],
      ['<code>test_diagnostics.py</code> (32)', 'Layered probing and the reasoning engine'],
      ['<code>test_vantage.py</code> (30)', 'Vantage classification and the fail-open rules'],
      ['<code>test_captures.py</code> (25)', 'The two-row capture policy and body sanitisation'],
      ['<code>test_ssl.py</code> (21)', 'Certificate parsing, classification, hostname matching'],
      ['<code>test_import_export.py</code> (35)', 'Header aliasing, validation, duplicate detection'],
      ['<code>test_branding_and_features.py</code> (21)', 'Logo upload and the feature gates'],
      ['<code>test_validators.py</code> (18)', 'URL parsing, blocked addresses, status normalisation'],
      ['<code>test_worker.py</code> (8)', 'Claiming, leasing, heartbeats'],
      ['<code>test_incidents_api.py</code>, <code>test_network.py</code> (12)',
       'Incident querying, and address classification']
    ]),

    DOCS.code(`cd backend
pytest                          # everything
pytest -m "not network"         # skip anything needing outbound access
pytest tests/test_checker.py -v
pytest -k "incident"`, 'shell'),

    DOCS.callout('note', 'respx, not a live server',
      '<p>HTTP-level tests use <code>respx</code> to intercept httpx, so probe behaviour is ' +
      'exercised without a real target. That is why the suite is fast and why ' +
      '<code>-m "not network"</code> leaves almost everything running.</p>'),

    `<h2>These documents</h2>
    <p>The site is deliberately build-free: plain HTML, one stylesheet and plain scripts. It opens
    from a <code>file://</code> path, from <code>python -m http.server</code>, or from any static
    host, with no toolchain and no dependencies to keep current.</p>`,

    DOCS.diagram(`
docs/
  index.html                 the shell, and the list of content scripts
  assets/
    styles.css               every style. Tokens on :root; dark mode
                             redefines only the tokens.
    registry.js              DOCS.page() plus the HTML helpers
                             (code, diagram, table, callout, cards,
                              stats, tabs, details, endpoint)
    app.js                   hash router, sidebar, search index,
                             table of contents, theme, copy buttons, tabs
  content/
    nav.js                   sidebar structure - also the source of the
                             prev/next order and the breadcrumb group
    <page>.js                one file per page, calling DOCS.page({...})
`, 'Adding a page means: write content/<id>.js, add a <script> tag to index.html, and list the id in content/nav.js. Nothing else.'),

    DOCS.code(`# Serve it locally
cd docs
python -m http.server 4173      # then open http://localhost:4173

# or just open docs/index.html directly - hash routing means
# it works from the filesystem too`, 'shell'),

    `<h3>Writing a page</h3>`,

    DOCS.code(`DOCS.page({
  id: 'my-page',
  title: 'My page',
  description: 'One sentence shown under the title.',
  body: [
    '<h2>A section</h2><p>Prose.</p>',
    DOCS.code('some --command', 'shell'),
    DOCS.diagram('A ---> B', 'What the diagram shows.'),
    DOCS.table(['Column'], [['cell']]),
    DOCS.callout('warn', 'Title', '<p>Body.</p>'),
    DOCS.details('Click to expand', '<p>Body.</p>'),
    DOCS.endpoint({ method: 'GET', path: '/api/thing', permission: 'thing:read',
                    summary: 'What it does.' })
  ].join('\\n')
});`, 'content/my-page.js'),

    `<p><code>h2</code> and <code>h3</code> elements are picked up automatically: they get ids,
    anchor links, a table-of-contents entry and their own search-index entry. Nothing has to be
    registered.</p>`,

    DOCS.callout('warn', 'One gotcha when writing content',
      '<p>Page bodies are JavaScript template literals, so a literal <code>$</code> followed by ' +
      '<code>{</code> is interpolation. Escape it as <code>\\${</code> when you quote a shell or ' +
      'Compose snippet that uses one. <code>$VAR</code> and <code>$(...)</code> are fine as they ' +
      'are.</p>'),

    `<h2>Keeping the docs true</h2>
    <p>This site describes an implementation, so it goes stale the way code comments do. The places
    it is most likely to drift:</p>`,

    DOCS.table(['If you change...', 'Update'], [
      ['<code>SETTING_SPECS</code>',
       '<a href="#/configuration">Configuration</a> &mdash; the runtime settings tables'],
      ['Anything in <code>app/core/config.py</code>',
       '<a href="#/configuration">Configuration</a> &mdash; the environment variable tables, and ' +
       '<code>.env.example</code>'],
      ['<code>ROLE_PERMISSIONS</code> or <code>Permission</code>',
       '<a href="#/users">Users and access control</a>, and the per-route permissions in ' +
       '<a href="#/api">the API reference</a>'],
      ['Any route signature',
       '<a href="#/api">API reference</a>. The generated OpenAPI at <code>/api/openapi.json</code> ' +
       'is the ground truth to diff against.'],
      ['A model or a migration',
       '<a href="#/database">Database</a> &mdash; the table list, the ER diagram, the migration table'],
      ['<code>resolve_check_interval</code> or the status machine',
       '<a href="#/monitoring">Monitoring engine</a>'],
      ['A worker task or its interval',
       '<a href="#/background-jobs">Background processing</a>'],
      ['<code>docker-compose.yml</code> or either Dockerfile',
       '<a href="#/deployment-docker">Deployment: Docker</a>'],
      ['A user-facing error string or a log event name',
       '<a href="#/troubleshooting">Troubleshooting</a> quotes many of them verbatim']
    ]),

    DOCS.callout('tip', 'The two authoritative cross-checks',
      '<p><code>/api/openapi.json</code> is generated from the route definitions, so it can never ' +
      'be out of date about routes and schemas. <code>GET /api/settings</code> returns every ' +
      'setting with its live value, type and bounds. Diff the API reference and the configuration ' +
      'page against those two before believing either.</p>')

  ].join('\n')
});
