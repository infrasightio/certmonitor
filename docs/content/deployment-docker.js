DOCS.page({
  id: 'deployment-docker',
  title: 'Deployment: Docker',
  description: 'The bundled Compose topology, both Dockerfiles, the entrypoint roles, health checks, volumes, and how to scale and upgrade.',
  body: [

    `<h2>Topology</h2>`,

    DOCS.diagram(`
   host
    |
    |  \${HTTP_PORT:-8080} -> 80        \${POSTGRES_PORT:-5432} bound to 127.0.0.1
    |          |                                     |
  +-|----------|-------------------------------------|-------------------+
  | v          v      docker network "infrasight" (bridge)               |
  |                                                                       |
  |  +-------------+      +-------------+      +--------------------+     |
  |  |  frontend   |----->|   backend   |----->|     postgres       |     |
  |  |  nginx:1.27 | :80  |  role: api  | 8000 |  postgres:16-alpine|     |
  |  |  + built SPA|      |  uvicorn    |      |  volume:           |     |
  |  +-------------+      +------+------+      |  postgres_data     |     |
  |                              |             +---------+----------+     |
  |                              v                       ^                |
  |                       +-------------+                |                |
  |                       |    redis    |<---------------+                |
  |                       | 7-alpine    |                |                |
  |                       | no persist  |      +---------+----------+     |
  |                       +-------------+      |      worker        |     |
  |                              ^             |  role: worker      |     |
  |                              +-------------|  same image        |     |
  |                                            +----+----+----+-----+     |
  |                                                 |    |    |           |
  |                            +--------------------+    |    +--------+  |
  |                            v                         v             v  |
  |                      +----------+            +----------+   +---------+|
  |                      |  tor-de  |            |  tor-us  |   | tor-sg  ||
  |                      | :9050    |            | :9050    |   | :9050   ||
  |                      +----+-----+            +----+-----+   +----+----+|
  +---------------------------|-----------------------|-------------|-----+
                              |                       |             |
                              v                       v             v
                        exits in DE              exits in US   exits in SG
                                  (and the worker's own egress, direct,
                                   for every ordinary check)
`, 'Only the frontend publishes a port to the world. Postgres is bound to loopback so an operator can run psql; the Tor SOCKS ports are not published at all, because a reachable SOCKS port is an open relay.'),

    `<h2>Services</h2>`,

    DOCS.table(['Service', 'Image', 'Restart', 'Published', 'Grace period'], [
      ['<code>postgres</code>', '<code>postgres:16-alpine</code>', '<code>unless-stopped</code>',
       '<code>127.0.0.1:5432</code>', '30s'],
      ['<code>redis</code>', '<code>redis:7-alpine</code>', '<code>unless-stopped</code>',
       'none', 'default'],
      ['<code>backend</code>', 'built from <code>./backend</code>', '<code>unless-stopped</code>',
       'none', '30s'],
      ['<code>worker</code>', 'the same image, <code>command: ["worker"]</code>',
       '<code>unless-stopped</code>', 'none', '45s'],
      ['<code>frontend</code>', 'built from <code>./frontend</code>', '<code>unless-stopped</code>',
       '<code>HTTP_PORT</code> (8080) &rarr; 80', 'default'],
      ['<code>tor-de</code>, <code>tor-us</code>, <code>tor-sg</code>',
       '<code>dperson/torproxy:latest</code>', '<code>unless-stopped</code>',
       'none (<code>expose</code> only)', 'default']
    ]),

    DOCS.callout('note', 'Three Tor containers, not one with three ports',
      '<p><code>ExitNodes</code> is a <em>global</em> torrc directive, so several SocksPorts on one ' +
      'instance would all leave through the same country &mdash; three circuits to one place rather ' +
      'than three places. Each container costs about 40&nbsp;MB of RAM. They share a YAML anchor ' +
      '(<code>&amp;tor</code>) and differ only in their <code>ExitNodes</code> line.</p>' +
      '<p>Remove these three services and unset <code>VANTAGE_POINTS</code> to turn the feature off ' +
      'entirely; with no vantages configured the worker behaves exactly as it did before. Swap them ' +
      'for gluetun, or any VPN container exposing SOCKS, by pointing <code>VANTAGE_POINTS</code> at ' +
      'it instead &mdash; nothing in the application knows what is behind the proxy.</p>'),

    `<h2>Health checks</h2>`,

    DOCS.table(['Service', 'Test', 'Interval / timeout / retries / start period'], [
      ['<code>postgres</code>', '<code>pg_isready -U $POSTGRES_USER -d $POSTGRES_DB</code>',
       '10s / 5s / 10 / 30s'],
      ['<code>redis</code>', '<code>redis-cli ping</code>', '10s / 3s / 5 / &mdash;'],
      ['<code>backend</code>', '<code>curl -fsS http://127.0.0.1:8000/live</code>',
       '30s / 5s / 3 / 60s'],
      ['<code>worker</code>', '<code>pgrep -f monitor_worker</code>', '30s / 5s / 3 / 40s'],
      ['<code>frontend</code>', '<code>curl -fsS http://127.0.0.1/healthz</code>', '30s / 5s / 3 / 15s']
    ]),

    DOCS.callout('tip', 'Why the backend probe uses /live and not /health',
      '<p><code>/live</code> touches no dependency. Probing <code>/health</code> would restart the ' +
      'API whenever the database blinked &mdash; which is exactly when you want the API up and ' +
      'reporting. The worker exposes no HTTP port at all, so its container probe is only ' +
      '&ldquo;is the process running&rdquo;; real liveness is the <code>monitoring_worker</code> ' +
      'field of the API&rsquo;s <code>/health</code>.</p>'),

    `<h2>Startup ordering</h2>`,

    DOCS.diagram(`
  postgres  ---- healthy ---->  backend  ---- started ---->  worker
      |                            ^                            |
      |                            |                            |
      +---- healthy ---------------+                            |
                                                                |
  redis  ---- started ---->  backend                            |
                                                                |
  backend ---- started ---->  frontend                          |
                                                                |
  Compose only ORDERS these. The real guarantees are in the entrypoint:
    api role     -> wait_for_database, then migrate, then seed
    worker role  -> wait_for_database, then wait_for_schema
  So a worker that starts before migrations finish waits rather than
  crash-looping against a missing table.
`, 'depends_on with condition: service_healthy handles postgres; the worker depends on backend only for ordering, because the API is what applies migrations.'),

    `<h2>Volumes and networks</h2>`,

    DOCS.table(['Name', 'Kind', 'Holds'], [
      ['<code>postgres_data</code>', 'Named volume, local driver',
       'Everything durable. Survives <code>docker compose down</code> and any container rebuild. ' +
       '<code>PGDATA</code> is <code>/var/lib/postgresql/data/pgdata</code>.'],
      ['<code>infrasight</code>', 'Bridge network', 'All services. Docker’s embedded DNS is how ' +
       'nginx finds <code>backend</code> and the worker finds <code>tor-de</code>.']
    ]),

    DOCS.callout('danger', 'The volume name is derived from the project name',
      '<p>It is <code>&lt;COMPOSE_PROJECT_NAME&gt;_postgres_data</code>. Changing ' +
      '<code>COMPOSE_PROJECT_NAME</code> points the stack at a <em>different, empty</em> volume ' +
      'while the existing data sits untouched in the old one. This is the single most likely way to ' +
      'lose sight of your data during an upgrade &mdash; see ' +
      '<a href="#/getting-started#upgrading-from-certmonitor">upgrading from CertMonitor</a>.</p>'),

    `<h2>The backend image</h2>
    <p>Two stages, built on <code>python:3.12-slim-bookworm</code>.</p>`,

    DOCS.diagram(`
  builder stage
     apt: build-essential, libpq-dev, libffi-dev, libssl-dev
          (needed to compile psycopg2 and cryptography where no wheel exists;
           none of it reaches the runtime image)
     python -m venv /opt/venv
     pip install -r requirements.txt

  runtime stage
     apt: libpq5           psycopg2 at runtime
          ca-certificates  so TLS verification of monitored endpoints has a
                           trust store at all
          curl             the container healthcheck
          tini             PID 1: reaps zombies, forwards SIGTERM to the worker
     COPY --from=builder /opt/venv /opt/venv
     playwright install --with-deps chromium  -> /ms-playwright  (~400 MB)
     useradd infrasight (uid 10001, gid 10001, nologin shell)
     COPY alembic.ini, alembic/, app/, docker/entrypoint.sh
     USER infrasight
     EXPOSE 8000
     HEALTHCHECK curl -fsS http://127.0.0.1:8000/live
     ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
     CMD ["api"]
`, 'Chromium is installed to a shared path rather than ~/.cache so the unprivileged runtime user can read it, and in the runtime stage rather than the builder because Playwright pulls the browser AND its shared libraries.'),

    DOCS.callout('tip', 'Dropping ~400 MB',
      '<p>Chromium is the single largest thing in the image. A deployment that does not want ' +
      'screenshots can delete the two <code>PLAYWRIGHT_BROWSERS_PATH</code> layers: ' +
      '<code>app/monitoring/screenshot.py</code> imports Playwright lazily and degrades to a ' +
      'recorded reason, so the worker runs fine without them. Set ' +
      '<code>SCREENSHOT_ENABLED=false</code> as well, to stop it trying.</p>'),

    `<h3>Security posture of the image</h3>
    <ul>
      <li>Runs as UID/GID 10001 with a <code>nologin</code> shell. Monitoring only needs outbound TCP,
      so no Linux capabilities are required.</li>
      <li><code>tini</code> as PID 1, so SIGTERM actually reaches the Python process &mdash; which is
      what makes the worker&rsquo;s graceful drain work.</li>
      <li>No build toolchain in the runtime layer.</li>
    </ul>`,

    `<h2>The frontend image</h2>`,

    DOCS.diagram(`
  builder stage   node:20-alpine
     COPY package.json package-lock.json*      (manifests first, so npm ci
     npm ci  (or npm install without a lockfile) is cached until deps change)
     COPY . .
     npm run build           ->  /app/dist, content-hashed filenames

  runtime stage   nginx:1.27-alpine
     apk add curl
     COPY --from=builder /app/dist  ->  /usr/share/nginx/html
     COPY nginx.conf                ->  /etc/nginx/conf.d/default.conf
     EXPOSE 80
     HEALTHCHECK curl -fsS http://127.0.0.1/healthz
`, 'The nginx master runs as root to bind :80 and write its pid, with workers as the nginx user - the stock image default, and the least surprising choice.'),

    `<h3>What nginx does</h3>`,

    DOCS.table(['Location', 'Behaviour'], [
      ['<code>/api/</code>',
       '<code>proxy_pass</code> to <code>backend:8000</code> over a keepalive upstream. Sets ' +
       '<code>X-Real-IP</code>, <code>X-Forwarded-For</code> (what the audit log records), ' +
       '<code>X-Forwarded-Proto</code> and <code>X-Request-ID</code>. ' +
       '<code>proxy_buffering off</code>; read timeout 120s, because manual checks and large imports ' +
       'legitimately take a while.'],
      ['<code>/health</code>, <code>/ready</code>, <code>/live</code>, <code>/branding</code>, ' +
       '<code>/branding/logo</code>',
       'Proxied with <code>access_log off</code> and a 10s read timeout. Branding rides along ' +
       'because it is the other unauthenticated root-mounted route.'],
      ['<code>/healthz</code>', 'Answered by nginx itself with <code>ok</code>. No upstream involved.'],
      ['<code>/assets/</code>',
       '<code>expires 1y</code>, <code>Cache-Control: public, immutable</code> &mdash; Vite emits ' +
       'content-hashed filenames, so these can be cached hard'],
      ['<code>/</code>',
       'SPA fallback to <code>index.html</code>, with <code>Cache-Control: no-store, ' +
       'must-revalidate</code> &mdash; caching it would leave clients on the old asset manifest ' +
       'after a deploy']
    ]),

    `<p>It also sets <code>client_max_body_size 12m</code> (above <code>MAX_UPLOAD_BYTES</code>, so
    the API produces the size error rather than the proxy), turns
    <code>proxy_intercept_errors</code> off so the API&rsquo;s JSON error bodies survive, gzips text
    responses over 1&nbsp;KB, and applies its own security headers including a CSP scoped to
    <code>self</code>.</p>`,

    `<h2>Common operations</h2>`,

    DOCS.tabs([
      {
        label: 'Day to day',
        html: DOCS.code(`docker compose up -d                  # start everything
docker compose ps                     # service status and health
docker compose logs -f                # follow everything
docker compose logs -f worker         # follow just the worker
docker compose restart worker         # restart one service
docker compose down                   # stop (volumes are preserved)`, 'shell')
      },
      {
        label: 'Scaling',
        html: DOCS.code(`docker compose up -d --scale worker=3`, 'shell') +
          `<p>Works with no configuration change. Each replica takes its container ID as its worker
          id, and <code>SKIP LOCKED</code> plus leases mean the three never check the same endpoint
          twice.</p>` +
          DOCS.callout('warn', 'Do not set WORKER_ID when scaling',
            '<p>The <code>worker</code> service deliberately declares no ' +
            '<code>container_name</code> and no <code>hostname</code>, because both are ' +
            'single-instance settings. Setting <code>WORKER_ID</code> in <code>.env</code> would ' +
            'give every replica the <em>same</em> id, collapsing three workers into one heartbeat ' +
            'row &mdash; so <code>/health</code> would report one worker and undercount the ' +
            'fleet.</p>') +
          `<p>The same caveat applies to <code>WORKER_REGION</code>: scaled replicas share the
          environment, so they all report the same region. That is correct when they are on one box.
          To label workers that genuinely sit in different places, run them as separate services with
          a <code>WORKER_REGION</code> each.</p>`
      },
      {
        label: 'Upgrading',
        html: DOCS.code(`git pull
docker compose build
docker compose up -d
docker compose logs -f backend    # watch the migrations apply`, 'shell') +
          `<p>Migrations run automatically in the <code>api</code> entrypoint before uvicorn starts.
          To apply them separately first:</p>` +
          DOCS.code(`docker compose run --rm backend migrate`, 'shell') +
          `<p>Setting <code>IMAGE_TAG</code> in <code>.env</code> tags the built images, which is what
          you want if you push them to a registry rather than building on the host.</p>`
      },
      {
        label: 'Backup',
        html: DOCS.code(`docker compose exec -T postgres pg_dump -U infrasight -d infrasight \\
  --format=custom --file=/tmp/infrasight.dump
docker compose cp postgres:/tmp/infrasight.dump ./infrasight-$(date +%F).dump`, 'shell') +
          DOCS.callout('danger', 'Back up the key material too',
            '<p>Endpoint credentials and notification-channel configuration are encrypted with a key ' +
            'derived from <code>ENCRYPTION_KEY</code> or <code>JWT_SECRET</code>. A dump restored ' +
            'without the matching key leaves every one of those undecryptable.</p>')
      }
    ]),

    `<h2>Resource expectations</h2>
    <p>No CPU or memory limits are declared in the Compose file, so containers are unbounded by
    default. Two figures from the code are worth knowing when you set your own:</p>

    <ul>
      <li>Each Tor container is about 40&nbsp;MB of RAM.</li>
      <li>Concurrent Chromium pages are the memory risk, not concurrent HTTP checks. Fifty concurrent
      checks is nothing; fifty concurrent Chromium pages is several gigabytes, which is why
      <code>SCREENSHOT_CONCURRENCY</code> defaults to 2 and is a separate knob from
      <code>WORKER_CONCURRENCY</code>.</li>
    </ul>

    <p>Watch actual usage on the <strong>System resources</strong> screen, which reports API and
    worker CPU and memory, database size with a per-table breakdown, and disk &mdash; all without a
    Docker socket.</p>`

  ].join('\n')
});
