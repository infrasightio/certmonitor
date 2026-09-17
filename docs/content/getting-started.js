DOCS.page({
  id: 'getting-started',
  title: 'Getting started',
  description: 'From a fresh clone to a running stack with a signed-in administrator and a first monitored endpoint.',
  body: [

    `<h2>Prerequisites</h2>`,

    DOCS.table(['For', 'You need', 'Why'], [
      ['Running the stack',
       'Docker Engine with the Compose plugin (<code>docker compose</code>, not <code>docker-compose</code>)',
       '<code>docker-compose.yml</code> uses Compose spec features: a top-level <code>name:</code>, ' +
       'YAML anchors and <code>condition: service_healthy</code> dependencies.'],
      ['Backend development',
       'Python 3.12, plus a reachable PostgreSQL 16',
       'The image is built on <code>python:3.12-slim-bookworm</code> and the code uses 3.12 syntax ' +
       '(<code>StrEnum</code>, <code>X | None</code> annotations).'],
      ['Frontend development',
       'Node.js 20',
       'The frontend image builds on <code>node:20-alpine</code>.'],
      ['Running the test suite',
       'Nothing beyond the Python dependencies',
       'The suite runs against a throwaway SQLite file. No PostgreSQL and no Redis are required.'],
      ['Screenshots (optional)',
       'Roughly 400&nbsp;MB of image space for Chromium',
       'Playwright and its browser are the single largest thing in the backend image. ' +
       'They are imported lazily, so a slimmed image still runs.']
    ]),

    DOCS.callout('warn', 'Outbound network access',
      '<p>The <strong>worker</strong> needs outbound access to everything it monitors. The API needs ' +
      'none. If you are writing firewall or NetworkPolicy rules, that distinction is the one that ' +
      'matters.</p>'),

    `<h2>Running with Docker Compose</h2>
    <p>This is the supported deployment. Five services come up: <code>postgres</code>,
    <code>redis</code>, <code>backend</code>, <code>worker</code> and <code>frontend</code>, plus the
    three optional <code>tor-*</code> vantage exits.</p>

    <h3>1. Create the environment file</h3>`,

    DOCS.code(`cp .env.example .env`, 'shell'),

    `<p>Then replace every value marked <code>CHANGE-ME</code>. At minimum:</p>`,

    DOCS.table(['Variable', 'What to set it to'], [
      ['<code>POSTGRES_PASSWORD</code>',
       'A strong password. Compose refuses to start without it &mdash; the variable is declared ' +
       '<code>:?POSTGRES_PASSWORD must be set in .env</code>.'],
      ['<code>JWT_SECRET</code>',
       'At least 32 random characters. <code>openssl rand -base64 48</code>. Not optional once ' +
       '<code>APP_ENV</code> is <code>production</code> or <code>staging</code>: the API refuses ' +
       'to start without it. Changing it later invalidates every existing session.'],
      ['<code>ENCRYPTION_KEY</code>',
       'Optional but recommended. Leave blank and it is derived from <code>JWT_SECRET</code>, which ' +
       'means rotating <code>JWT_SECRET</code> would make every stored endpoint credential and ' +
       'notification-channel config undecryptable.'],
      ['<code>ADMIN_PASSWORD</code>',
       'The bundled default is <code>Passwd@123</code> and is public knowledge. It is used only on ' +
       'first boot, and the account is created with <code>must_change_password</code> set.']
    ]),

    `<h3>2. Start the stack</h3>`,

    DOCS.code(`docker compose up -d
docker compose ps
docker compose logs -f backend`, 'shell'),

    `<p>The dashboard is published on <code>HTTP_PORT</code>, which defaults to
    <strong>8080</strong>. PostgreSQL is published on <code>127.0.0.1:5432</code> only, so an operator
    can run <code>psql</code> or take a backup from the host; comment that <code>ports:</code> block
    out to close it entirely.</p>`,

    `<h3>3. What happens on first boot</h3>`,

    DOCS.diagram(`
  backend container starts
        |
        v
  entrypoint.sh, role "api"
        |
        +--> wait_for_database    poll SELECT 1, up to DB_WAIT_ATTEMPTS (60) x DB_WAIT_DELAY (2s)
        |
        +--> alembic upgrade head          apply migrations 0001 .. 0018
        |
        +--> python -m app.bootstrap       seed, once, before uvicorn forks
        |         |
        |         +-- pg_try_advisory_lock(728113501)   serialise concurrent replicas
        |         +-- ensure_roles()        admin / approver / viewer + their permissions
        |         +-- settings_service.ensure_seeded()   one row per SettingSpec
        |         +-- seed_environments()   only if the table is empty
        |         +-- ensure_default_admin()
        |
        +--> exec uvicorn app.main:app --workers \${API_WORKERS:-2}

  worker container starts
        |
        v
  entrypoint.sh, role "worker"
        |
        +--> wait_for_database
        +--> wait_for_schema      poll until endpoints, monitoring_results,
        |                         system_settings all exist (up to 90 x 2s)
        +--> exec python -m app.workers.monitor_worker
`, 'Only the api role runs migrations. The worker waits for the schema the API creates, which is what stops two containers racing.'),

    DOCS.callout('note', 'Seeding is deliberately not only in the app lifespan',
      '<p>With <code>API_WORKERS &gt; 1</code> the FastAPI lifespan runs once per uvicorn worker ' +
      'process, and the advisory lock means the losing processes log ' +
      '<code>bootstrap_skipped</code> and move on. If the lock holder had failed, the instance would ' +
      'come up with no admin account. Running <code>python -m app.bootstrap</code> as its own ' +
      'entrypoint step makes it happen exactly once, and a non-zero exit stops the container.</p>'),

    `<h3>4. Sign in</h3>
    <p>Open <code>http://localhost:8080</code> and sign in with <code>ADMIN_USERNAME</code> and
    <code>ADMIN_PASSWORD</code>. Because <code>ADMIN_FORCE_PASSWORD_CHANGE</code> defaults to true,
    the account is created with <code>must_change_password</code> set and every route except
    <code>/api/auth/me</code>, <code>/api/auth/change-password</code> and
    <code>/api/auth/logout</code> answers <strong>403</strong> with an
    <code>X-Password-Change-Required: true</code> header until the password is replaced. The SPA reads
    that header and routes to the password screen rather than showing a permission error.</p>`,

    DOCS.callout('tip', 'The admin account is created once',
      '<p><code>ensure_default_admin</code> never overwrites an existing account, so changing ' +
      '<code>ADMIN_PASSWORD</code> in <code>.env</code> after first boot has no effect. To reset a ' +
      'forgotten administrator password, use another administrator&rsquo;s ' +
      '<code>POST /api/users/{id}/reset-password</code>.</p>'),

    `<h3>5. Add the first endpoint</h3>
    <p>Either through <strong>Endpoints &rarr; Add endpoint</strong>, or with the API:</p>`,

    DOCS.code(`# Sign in
TOKEN=$(curl -sS -X POST http://localhost:8080/api/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"admin","password":"<your password>"}' | jq -r .access_token)

# Create an endpoint
curl -sS -X POST http://localhost:8080/api/endpoints \\
  -H "Authorization: Bearer $TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{
        "name": "Payments API health",
        "url": "https://payments.internal.example/health",
        "environment": "production",
        "interval_seconds": 60,
        "expected_status_codes": "200",
        "team": "platform"
      }'`, 'shell'),

    `<p>A new endpoint is scheduled immediately rather than one interval from now, so its first real
    status appears within one worker poll (<code>WORKER_POLL_INTERVAL_SECONDS</code>, default 5
    seconds).</p>`,

    `<h2>Local development</h2>
    <p>There is no dev Compose file in the repository. The pattern the code assumes is: run
    PostgreSQL in a container, run the API and worker from source, run Vite against them.</p>`,

    DOCS.tabs([
      {
        label: 'Backend API',
        html:
          DOCS.code(`cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt

# Point at a database and give the settings what they require
export DATABASE_URL=postgresql+asyncpg://infrasight:infrasight@localhost:5432/infrasight
export JWT_SECRET=$(openssl rand -hex 32)
export APP_ENV=development
export LOG_FORMAT=console

alembic upgrade head
python -m app.bootstrap
uvicorn app.main:app --reload --port 8000`, 'shell') +
          `<p>Interactive API docs are then at <code>http://localhost:8000/api/docs</code> (Swagger UI)
          and <code>/api/redoc</code>, with the raw schema at <code>/api/openapi.json</code>.</p>` +
          DOCS.callout('note', 'DATABASE_URL is normalised for you',
            '<p>A plain <code>postgresql://</code> or <code>postgres://</code> DSN is rewritten to ' +
            '<code>postgresql+asyncpg://</code> by a field validator, so pasting the DSN your ' +
            'provider gives you works. Alembic uses the <code>sync_database_url</code> property, ' +
            'which swaps <code>+asyncpg</code> for <code>+psycopg2</code>.</p>')
      },
      {
        label: 'Worker',
        html:
          DOCS.code(`cd backend
source .venv/bin/activate
export DATABASE_URL=postgresql+asyncpg://infrasight:infrasight@localhost:5432/infrasight
export JWT_SECRET=<the same value as the API>
export WORKER_ENABLED=true
export LOG_FORMAT=console

python -m app.workers.monitor_worker`, 'shell') +
          `<p>The worker and the API must share <code>JWT_SECRET</code> (or
          <code>ENCRYPTION_KEY</code>), because that is what endpoint credentials are encrypted with.
          If they differ, the worker logs <code>endpoint_credential_undecryptable</code> and records
          the check as a <code>config_error</code> failure rather than crashing.</p>` +
          `<p>Setting <code>WORKER_ENABLED=false</code> makes the process log
          <code>worker_disabled</code> and exit immediately without monitoring anything.</p>`
      },
      {
        label: 'Frontend',
        html:
          DOCS.code(`cd frontend
npm install
npm run dev        # http://localhost:5173`, 'shell') +
          `<p>The Vite dev server proxies <code>/api</code>, <code>/health</code> and
          <code>/ready</code> to <code>VITE_API_TARGET</code> (default
          <code>http://localhost:8000</code>), so the browser sees a single origin &mdash; the same
          topology nginx provides in production. That keeps CORS and relative URLs behaving
          identically in both environments, which is why <code>CORS_ORIGINS</code> can stay empty.</p>` +
          DOCS.table(['Script', 'Does'], [
            ['<code>npm run dev</code>', 'Vite dev server on :5173 with the API proxy'],
            ['<code>npm run build</code>', 'Production build into <code>dist/</code>'],
            ['<code>npm run preview</code>', 'Serve the built bundle on :5173'],
            ['<code>npm run lint</code>', 'ESLint over <code>src</code>']
          ])
      },
      {
        label: 'Tests',
        html:
          DOCS.code(`cd backend
source .venv/bin/activate
pytest                       # ~500 tests across 18 modules
pytest -m "not network"      # skip anything needing outbound access
pytest tests/test_checker.py -v`, 'shell') +
          `<p><code>tests/conftest.py</code> sets every environment variable it needs
          <em>before</em> importing the application package, because settings are read once at import
          time. It points <code>DATABASE_URL</code> at a temporary SQLite file, blanks
          <code>REDIS_URL</code> so the rate limiter and preview store use their in-process
          fallbacks, and creates the schema from the same declarative metadata the migrations were
          written from.</p>` +
          DOCS.callout('note', 'Why SQLite works here',
            '<p>The models carry dialect variants for exactly this reason: <code>JSONType</code> is ' +
            '<code>JSONB</code> on PostgreSQL and plain <code>JSON</code> elsewhere, and ' +
            '<code>BigIntType</code> is <code>BIGINT</code> on PostgreSQL and <code>INTEGER</code> ' +
            'on SQLite, because SQLite has no autoincrementing <code>BIGINT</code>. ' +
            '<code>TimestampTZ</code> is a <code>TypeDecorator</code> that re-attaches UTC on ' +
            'load, because SQLite ignores <code>timezone=True</code> and would otherwise hand ' +
            'back naive datetimes that the application cannot subtract. ' +
            '<code>asyncio_mode = auto</code> in <code>pytest.ini</code> keeps the async tests free ' +
            'of decorators.</p>')
      }
    ]),

    `<h2>Entrypoint roles</h2>
    <p>The backend image takes a role as its command. This is what lets one artefact serve both
    processes.</p>`,

    DOCS.table(['Role', 'Does', 'Used by'], [
      ['<code>api</code> <em>(default)</em>',
       'Waits for the database, runs <code>alembic upgrade head</code>, seeds, then executes uvicorn ' +
       'with <code>--proxy-headers --forwarded-allow-ips \'*\' --no-access-log</code>.',
       'The <code>backend</code> service'],
      ['<code>worker</code>',
       'Waits for the database and for the schema, then executes ' +
       '<code>python -m app.workers.monitor_worker</code>.',
       'The <code>worker</code> service'],
      ['<code>migrate</code>',
       'Waits for the database, applies migrations, exits.',
       'A Kubernetes pre-upgrade Job, or a one-off <code>docker compose run</code>'],
      ['<code>seed</code>',
       'Waits for the database and schema, runs the bootstrap, exits.',
       'Re-seeding after a manual schema restore'],
      ['<code>shell</code>',
       'An interactive Python with the app importable.',
       'Debugging'],
      ['<em>anything else</em>',
       'Executed as a raw command, so <code>docker compose run backend &lt;cmd&gt;</code> stays usable.',
       'Ad-hoc tooling']
    ]),

    `<h2>Upgrading from CertMonitor</h2>
    <p>The application was previously called CertMonitor. Two settings in <code>.env.example</code>
    exist solely to keep an existing deployment pointing at its existing data:</p>

    <ul>
      <li><code>COMPOSE_PROJECT_NAME</code> names the Docker network, the containers and &mdash;
      critically &mdash; the Postgres volume (<code>&lt;project&gt;_postgres_data</code>). Set it to
      <code>certmonitor</code> or the stack will attach a brand-new empty volume while the existing
      data sits untouched.</li>
      <li><code>POSTGRES_DB</code> and <code>POSTGRES_USER</code> name the role and database that
      already exist inside that volume. Keep them as <code>certmonitor</code>.</li>
    </ul>

    <p>Two compatibility shims are in the application code itself: the SPA reads the pre-rename
    <code>certmonitor.*</code> <code>localStorage</code> keys as a fallback and migrates them, so the
    rename does not sign everyone out; and signed webhooks send the HMAC under both
    <code>X-InfraSight-Signature</code> and <code>X-CertMonitor-Signature</code>, same value, so a
    receiver written against the old name keeps verifying.</p>`

  ].join('\n')
});
