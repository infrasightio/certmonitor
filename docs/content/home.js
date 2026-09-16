DOCS.page({
  id: 'home',
  title: 'InfraSight',
  navTitle: 'Overview',
  description: 'Endpoint and TLS certificate monitoring for infrastructure you own, with the incident, change and root-cause workflow around it.',
  body: [

    DOCS.callout('note', 'How to read these docs',
      '<p>Everything on this site is derived from the source in this repository &mdash; the FastAPI ' +
      'application under <code>backend/app</code>, the React SPA under <code>frontend/src</code>, ' +
      '<code>docker-compose.yml</code> and <code>.env.example</code>. Where the code does not settle a ' +
      'question, the page says so rather than guessing.</p>'),

    `<h2>What InfraSight is</h2>
    <p>InfraSight watches a fleet of HTTP, TCP and TLS endpoints from the outside. A worker process
    probes each endpoint on a schedule, records what happened, decides whether the endpoint is up,
    opens an incident when it is not, and notifies whoever needs to know. Around that core sit the
    workflows an operations team needs once monitoring exists: a certificate inventory, a change and
    deployment record that pauses monitoring while a deploy is in flight, a layered diagnostics engine,
    and a lightweight root-cause-analysis process.</p>

    <p>It is a single self-hosted stack. Nothing about the monitored fleet leaves the machine it runs on:
    there is no SaaS backend, no telemetry, and the one optional outbound call to a third party
    (<code>VANTAGE_ECHO_URL</code>, which asks a proxy where its traffic comes out) can be switched off
    by blanking a setting.</p>`,

    `<h2>Why it exists</h2>
    <p>Three design commitments run through the codebase and explain most of what you will read here.</p>`,

    DOCS.cards([
      {
        kicker: 'Commitment 1',
        title: 'One incident per outage',
        body: 'A partial unique index on <code>incidents</code> allows at most one open incident per ' +
              'endpoint. Four failed checks are one problem, not four alerts.'
      },
      {
        kicker: 'Commitment 2',
        title: 'Never invent infrastructure',
        body: 'Diagnose observes an endpoint from outside and tags every statement as ' +
              '<code>observed</code>, <code>inferred</code> or <code>unknown</code>. It has no view ' +
              'of pods or databases and says so.'
      },
      {
        kicker: 'Commitment 3',
        title: 'Process never blocks recovery',
        body: 'RCA is optional and independent of the incident lifecycle. An incident can be closed ' +
              'with its RCA still pending, and that combination is valid.'
      }
    ]),

    `<h2>Key capabilities</h2>`,

    DOCS.table(['Capability', 'What it does', 'Where it lives'], [
      ['<strong>Endpoint monitoring</strong>',
       'HTTP, TCP and TLS checks with per-phase timings (DNS, connect, TLS, TTFB), expected status ' +
       'codes, body-substring matching, redirect following and authenticated requests.',
       '<code>app/monitoring/checker.py</code>'],
      ['<strong>Certificate inventory</strong>',
       'Every observed certificate is stored with its chain, SAN list, key details and fingerprint. ' +
       'A new row is written when the fingerprint changes, giving a rotation history.',
       '<code>app/monitoring/ssl_inspect.py</code>'],
      ['<strong>Incidents and alerts</strong>',
       'One incident per continuous outage, alerts with cooldown suppression, delivery to webhook, ' +
       'Slack, Teams, PagerDuty or e-mail.',
       '<code>app/services/alert_service.py</code>, <code>notification_service.py</code>'],
      ['<strong>Vantage-point confirmation</strong>',
       'Before the check that would open an incident, the endpoint is re-checked through configured ' +
       'SOCKS proxies. A verdict can only ever withhold an incident, never open one.',
       '<code>app/services/vantage_service.py</code>'],
      ['<strong>Diagnose</strong>',
       'Layered isolation (DNS to TCP to TLS to HTTP) plus stored history and correlation, producing ' +
       'ranked candidate causes with the evidence behind each.',
       '<code>app/services/diagnostics_service.py</code>'],
      ['<strong>Change management</strong>',
       'Change requests, approval where the environment demands it, and a deployment that pauses the ' +
       'affected endpoints and health-checks them on resume.',
       '<code>app/services/change_service.py</code>'],
      ['<strong>RCA</strong>',
       'Optional post-incident analysis owned by a person or a team, with a draft assembled from ' +
       'stored evidence and analytics over recurring causes.',
       '<code>app/services/rca_service.py</code>'],
      ['<strong>Bulk import and export</strong>',
       'Validate-then-confirm CSV/Excel import with per-row errors and duplicate detection; ' +
       'configuration export as CSV or Excel.',
       '<code>app/services/import_export_service.py</code>'],
      ['<strong>Self-observation</strong>',
       'Disk, database size, per-service CPU and memory, worker fleet state and vantage exits &mdash; ' +
       'measured without mounting the Docker socket.',
       '<code>app/services/resource_service.py</code>']
    ]),

    `<h2>Architecture at a glance</h2>
    <p>Five core services in the bundled topology, plus three optional Tor containers used only for
    vantage-point confirmation. The API and the worker run the <em>same image</em> with
    different entrypoint roles, so they cannot disagree about check semantics or the schema.</p>`,

    DOCS.diagram(`
                          Browser
                             |
                             | :8080  (single origin - no CORS)
                             v
            +----------------------------------+
            |  frontend  (nginx + built SPA)   |
            |  serves /  and /docs (this site) |
            |  proxies /api, /health, /ready,  |
            |  /live, /branding                |
            +----------------+-----------------+
                             | http://backend:8000
                             v
            +----------------------------------+        +---------------------+
            |  backend  (role: api)            |        |  worker             |
            |  FastAPI + uvicorn               |        |  (same image,       |
            |  reads/writes, never probes      |        |   role: worker)     |
            +----+------------------------+----+        +----+-----------+----+
                 |                        |                  |           |
                 |                        |                  |           | probes
                 v                        v                  v           v
          +-------------+          +-------------+    +-------------+  monitored
          | postgres 16 |<---------| redis 7     |    | postgres 16 |  endpoints
          | all state   |  (rate   | optional    |    | (shared)    |     +
          +-------------+  limits, +-------------+    +-------------+  tor-de /
                           import                                      tor-us /
                           previews)                                   tor-sg
                                                                       (vantage
                                                                        exits)
`, 'The bundled Docker Compose topology. Only the frontend publishes a host port.'),

    `<p>The API never performs an endpoint check, so a slow or unreachable monitored host can never
    delay an API request. The worker never serves HTTP. They communicate only through PostgreSQL:
    the worker claims due endpoints with <code>SELECT ... FOR UPDATE SKIP LOCKED</code> and writes a
    heartbeat row that <code>/health</code> reads back.</p>`,

    DOCS.cards([
      { href: '#/architecture', kicker: 'Deep dive', title: 'Architecture',
        body: 'Process model, module layout, the worker loop and how the two halves stay in step.' },
      { href: '#/request-flow', kicker: 'Deep dive', title: 'Request and data flow',
        body: 'What happens between a browser click and a database row, for every major path.' },
      { href: '#/monitoring', kicker: 'Deep dive', title: 'Monitoring engine',
        body: 'The check lifecycle, cadence resolution, status transitions and retry rules.' }
    ]),

    `<h2>Technology stack</h2>
    <p>Versions are the pinned ones in <code>backend/requirements.txt</code> and
    <code>frontend/package.json</code>.</p>`,

    DOCS.tabs([
      {
        label: 'Backend',
        html: DOCS.table(['Component', 'Version', 'Role'], [
          ['Python', '3.12 (slim-bookworm image)', 'Runtime for both the API and the worker'],
          ['FastAPI', '0.115.6', 'HTTP API, OpenAPI generation, dependency injection'],
          ['uvicorn', '0.34.0', 'ASGI server, <code>API_WORKERS</code> processes'],
          ['SQLAlchemy', '2.0.36', 'Async ORM, declarative models'],
          ['asyncpg / psycopg2-binary', '0.30.0 / 2.9.10', 'Async driver for the app; sync driver for Alembic'],
          ['Alembic', '1.14.0', 'Schema migrations (17 revisions, linear chain)'],
          ['Pydantic / pydantic-settings', '2.10.4 / 2.7.1', 'Request and response schemas, environment configuration'],
          ['httpx', '0.28.1 (with <code>http2</code>, <code>socks</code>)', 'The HTTP client every check uses'],
          ['cryptography', '44.0.0', 'X.509 parsing, Fernet encryption of stored credentials'],
          ['PyJWT / passlib[bcrypt]', '2.10.1 / 1.7.4', 'Access and refresh tokens; bcrypt password hashing'],
          ['structlog', '24.4.0', 'JSON or console structured logging with secret redaction'],
          ['redis', '5.2.1', 'Optional: shared rate limits and import previews'],
          ['openpyxl', '3.1.5', 'Excel import and export'],
          ['Playwright', '1.49.1', 'Optional: renders endpoint screenshots via Chromium']
        ])
      },
      {
        label: 'Frontend',
        html: DOCS.table(['Component', 'Version', 'Role'], [
          ['React', '18.3.1', 'UI, with <code>React.lazy</code> for every screen behind a click'],
          ['Vite', '6.0.7', 'Dev server and production build'],
          ['react-router-dom', '6.28.1', 'Routing, permission and feature gates'],
          ['axios', '1.7.9', 'One instance with token attach, transparent refresh and error normalisation'],
          ['Tailwind CSS', '3.4.17', 'Styling'],
          ['recharts', '2.15.0', 'Charts, split into their own bundle chunk'],
          ['lucide-react', '0.469.0', 'Icons'],
          ['date-fns', '4.1.0', 'Date formatting']
        ])
      },
      {
        label: 'Infrastructure',
        html: DOCS.table(['Component', 'Version', 'Role'], [
          ['PostgreSQL', '16-alpine', 'Every piece of durable state'],
          ['Redis', '7-alpine', 'Optional hardening: cross-replica login rate limits, import previews'],
          ['nginx', '1.27-alpine', 'Serves the SPA and reverse-proxies the API on one origin'],
          ['tini', 'Debian package', 'PID 1 in the backend image: reaps zombies, forwards SIGTERM'],
          ['dperson/torproxy', 'latest', 'Optional: three SOCKS exits used for vantage-point confirmation']
        ])
      }
    ]),

    `<h2>System health as a concept</h2>
    <p>InfraSight distinguishes three questions and answers each on its own route, because conflating
    them is how a database blip ends up restarting healthy pods.</p>`,

    DOCS.table(['Route', 'Question', 'Fails when'], [
      ['<code>GET /live</code>',
       'Is this process still answering?',
       'Never, short of the process being gone. It touches no dependency.'],
      ['<code>GET /ready</code>',
       'Should this instance receive traffic?',
       'The database is unreachable, or the schema exists but has not been seeded ' +
       '(checked by looking for a seeded role).'],
      ['<code>GET /health</code>',
       'Is the whole application healthy?',
       '<strong>503</strong> when the database is unreachable. A stale worker heartbeat degrades the ' +
       'response to <code>degraded</code> but keeps it at 200 &mdash; the API can still serve the ' +
       'dashboard and accept configuration.']
    ]),

    `<p>The API has no direct channel to the worker, which is the point of separating them. Worker
    liveness is inferred from the heartbeat rows each worker writes every
    <code>WORKER_HEARTBEAT_SECONDS</code>; a heartbeat older than
    <code>WORKER_STALE_AFTER_SECONDS</code> is stale, and one older than the retire window is treated
    as a replaced container and ignored.</p>`,

    `<h2>Where to go next</h2>`,

    DOCS.cards([
      { href: '#/getting-started', kicker: 'Start here', title: 'Getting started',
        body: 'Prerequisites, first boot with Docker Compose, local development, the first sign-in.' },
      { href: '#/configuration', kicker: 'Reference', title: 'Configuration',
        body: 'Every environment variable and every runtime setting, and which layer wins.' },
      { href: '#/api', kicker: 'Reference', title: 'API reference',
        body: 'Every route, its permission, its parameters and its responses.' },
      { href: '#/troubleshooting', kicker: 'Operations', title: 'Troubleshooting',
        body: 'Real log events and error strings, and what each one means.' }
    ])

  ].join('\n')
});
