DOCS.page({
  id: 'deployment-kubernetes',
  title: 'Deployment: Kubernetes',
  description: 'No manifests ship with the repository. What does ship is an application designed for a cluster - here is what it assumes, and what a chart has to get right.',
  body: [

    DOCS.callout('warn', 'Status: no manifests, no Helm chart, no CI/CD in this repository',
      '<p>The repository contains <code>docker-compose.yml</code> and two Dockerfiles. There is no ' +
      '<code>k8s/</code> directory, no <code>Chart.yaml</code>, no ' +
      '<code>.github/workflows</code>, no <code>.gitlab-ci.yml</code> and no ' +
      '<code>Jenkinsfile</code>. Everything below is derived from what the application actually ' +
      'does &mdash; its probes, its identity model, its locking and its shutdown behaviour &mdash; ' +
      'plus the design notes the maintainers left in the README. Treat it as the specification a ' +
      'chart has to satisfy, not as a manifest you can apply.</p>'),

    `<h2>What the application already assumes</h2>
    <p>These are properties of the code, not aspirations, and they are why a chart is mostly
    mechanical:</p>`,

    DOCS.table(['Property', 'Where it comes from'], [
      ['<strong>Three separate probe endpoints</strong>',
       '<code>/live</code> touches no dependency, <code>/ready</code> requires a seeded schema, ' +
       '<code>/health</code> reports overall state. They exist precisely so liveness and readiness ' +
       'can differ.'],
      ['<strong>Stateless API</strong>',
       'No server-side session store. Revocation is <code>token_version</code> in the database, so ' +
       'any replica can serve any request.'],
      ['<strong>Coordination-free worker scaling</strong>',
       '<code>SELECT ... FOR UPDATE SKIP LOCKED</code> plus a lease. Replicas never check the same ' +
       'endpoint twice, and a dead replica’s work is reclaimed when its lease expires.'],
      ['<strong>Per-pod worker identity for free</strong>',
       'The worker id defaults to the hostname, which in Kubernetes is the pod name. Distinct ' +
       'replicas therefore get distinct ids with no configuration.'],
      ['<strong>Migration safety under concurrent starts</strong>',
       'Seeding takes a PostgreSQL advisory lock; the losing process logs ' +
       '<code>bootstrap_skipped</code> and moves on.'],
      ['<strong>Graceful drain</strong>',
       'SIGTERM releases leases, deletes the worker’s own heartbeat row and waits for in-flight ' +
       'renders, all within the 45 seconds Compose already allows.'],
      ['<strong>Twelve-factor configuration</strong>',
       'Every environment-specific value is an environment variable, so one image is promoted across ' +
       'environments without a rebuild.'],
      ['<strong>Non-root, capability-free image</strong>',
       'UID 10001, and monitoring needs only outbound TCP.']
    ]),

    `<h2>Workloads</h2>`,

    DOCS.diagram(`
  Ingress  ---->  Service(frontend)  ---->  Deployment(frontend)   nginx + SPA
                                                   |
                                                   |  /api -> backend:8000
                                                   v
                        Service(backend)  ---->  Deployment(backend)
                                                   args: ["api"]     N replicas
                                                   |
                          Deployment(worker)       |
                          args: ["worker"]         |
                          M replicas, no Service   |
                                    |              |
                                    v              v
                              PostgreSQL (managed)      Redis
                                                   (required for N > 1)

  Job(migrate)  args: ["migrate"]
      helm.sh/hook: pre-install,pre-upgrade
`, 'The worker is a separate Deployment, never a sidecar - it has to scale independently of the API.'),

    DOCS.table(['Workload', 'Kind', 'Notes'], [
      ['frontend', 'Deployment + Service + Ingress',
       'Stateless. nginx proxies <code>/api</code> to the backend Service by name, so the browser ' +
       'still sees one origin and <code>CORS_ORIGINS</code> stays empty.'],
      ['backend', 'Deployment + Service', 'Stateless. Scale freely once Redis is present.'],
      ['worker', 'Deployment, <strong>no Service</strong>',
       'No HTTP port. Scale by replica count alone.'],
      ['migrate', 'Job, pre-install/pre-upgrade hook',
       'Same image, <code>args: ["migrate"]</code>. Runs <code>alembic upgrade head</code> and exits.']
    ]),

    `<h3>Migrations</h3>
    <p>Two workable approaches:</p>

    <ol>
      <li><strong>A pre-upgrade Job</strong> with <code>args: ["migrate"]</code>. Cleanest, and the
      one to prefer.</li>
      <li><strong>Leave migration-on-start as it is</strong> and keep the API at one replica during
      the upgrade window. This is safe because the advisory lock serialises concurrent starts, but
      the Job is more predictable.</li>
    </ol>

    <p>Either way the worker does not need changing: its entrypoint already waits for the schema
    rather than assuming it.</p>`,

    `<h2>Probes</h2>`,

    DOCS.code(`# backend
livenessProbe:
  httpGet: { path: /live, port: 8000 }
  initialDelaySeconds: 20
  periodSeconds: 15
readinessProbe:
  httpGet: { path: /ready, port: 8000 }
  initialDelaySeconds: 10
  periodSeconds: 10`, 'backend probes'),

    DOCS.callout('danger', 'Never use /health for liveness',
      '<p><code>/health</code> returns 503 when the database is unreachable. Using it as a liveness ' +
      'probe means a database blip restarts every API pod &mdash; at precisely the moment you want ' +
      'the API up and reporting. <code>/live</code> exists for this reason and touches no ' +
      'dependency.</p>'),

    `<p>The worker has no HTTP port, so use an <code>exec</code> probe on the process &mdash; the same
    shape as the Compose health check &mdash; and watch the <code>monitoring_worker</code> field of
    the API&rsquo;s <code>/health</code> for real liveness.</p>`,

    DOCS.code(`# worker
livenessProbe:
  exec:
    command: ["sh", "-c", "pgrep -f monitor_worker > /dev/null"]
  initialDelaySeconds: 40
  periodSeconds: 30`, 'worker probe'),

    `<h2>Configuration</h2>
    <p>Non-secret values in a <code>ConfigMap</code>; secrets in a <code>Secret</code> (or External
    Secrets / Vault). Mount both with <code>envFrom</code>. The full inventory is on the
    <a href="#/configuration">configuration page</a>; these four must be secrets:</p>`,

    DOCS.table(['Secret', 'Consequence of getting it wrong'], [
      ['<code>JWT_SECRET</code>',
       'Rotating it invalidates every session <em>and</em>, unless <code>ENCRYPTION_KEY</code> is set ' +
       'separately, makes every stored credential undecryptable'],
      ['<code>ENCRYPTION_KEY</code>',
       'Set it explicitly in a cluster. Deriving it from <code>JWT_SECRET</code> couples two ' +
       'rotations that should be independent.'],
      ['<code>POSTGRES_PASSWORD</code> / <code>DATABASE_URL</code>',
       'The DSN carries the password, so the whole variable is a secret'],
      ['<code>ADMIN_PASSWORD</code>',
       'Used only on first boot, but it is a real credential until the first sign-in']
    ]),

    DOCS.callout('warn', 'Redis stops being optional above one API replica',
      '<p>Two things are shared state on the API side: login rate limits and import previews. ' +
      'Without Redis, rate limits become per-pod &mdash; the effective limit is multiplied by the ' +
      'replica count &mdash; and an import preview lives in one pod’s memory, so the confirm ' +
      'request needs sticky sessions to land on the same pod. Both degrade quietly rather than ' +
      'erroring, which is what makes this worth stating.</p>'),

    `<h2>Database</h2>
    <p>Use managed PostgreSQL and set <code>DATABASE_URL</code> directly rather than running the
    <code>postgres</code> service. A plain <code>postgresql://</code> DSN is accepted &mdash; the
    settings validator rewrites it to <code>postgresql+asyncpg://</code>, and Alembic derives the
    <code>psycopg2</code> form from it.</p>

    <p>Size the pools per workload: the API holds a connection per in-flight request
    (<code>DB_POOL_SIZE</code> + <code>DB_MAX_OVERFLOW</code> per pod), the worker holds one short
    transaction per check. Total connections is the sum across every pod, so check it against the
    server&rsquo;s <code>max_connections</code> before scaling.</p>`,

    `<h2>Scaling and HPA</h2>`,

    DOCS.table(['Workload', 'Scales on', 'Caveat'], [
      ['backend', 'CPU or request concurrency, the usual HPA signals',
       'Needs Redis. Each pod holds its own database pool.'],
      ['worker', 'Replica count',
       'Not usefully driven by CPU: the loop is I/O-bound and mostly idle. Scale on how many ' +
       'endpoints are due &mdash; and note that raising <code>WORKER_CONCURRENCY</code> on one pod ' +
       'is often the cheaper answer than adding pods.'],
      ['frontend', 'CPU, or not at all',
       'Serving static files; one or two replicas is usually enough.']
    ]),

    DOCS.callout('tip', 'Worker id in a cluster',
      '<p>Leave <code>WORKER_ID</code> unset. The hostname is the pod name, which is already unique ' +
      'per replica. Set it explicitly &mdash; via <code>fieldRef: metadata.name</code>, never a ' +
      'literal &mdash; only when you want to control the label shown in ' +
      '<code>/api/workers</code>. For <code>WORKER_REGION</code>, take the value from the ' +
      'node&rsquo;s topology label so the fleet view reflects where pods actually are.</p>'),

    `<h2>Networking</h2>
    <p>The asymmetry matters for <code>NetworkPolicy</code>:</p>

    <ul>
      <li><strong>The worker needs broad egress</strong> &mdash; to everything it monitors, plus any
      vantage proxies, plus <code>VANTAGE_ECHO_URL</code> if that is set. Write the egress rules
      around the fleet it watches.</li>
      <li><strong>The API needs almost none</strong> &mdash; PostgreSQL, Redis, whatever notification
      channels are configured, and outbound access only for manual checks and Diagnose runs, which an
      operator triggers.</li>
      <li><strong>The frontend needs only the backend Service.</strong></li>
    </ul>

    <p>Ingress terminates TLS in front of the frontend Service. Set <code>ALLOWED_HOSTS</code> if the
    API is ever exposed directly rather than behind that nginx; leave it empty otherwise. Leave
    <code>CORS_ORIGINS</code> empty unless you serve the SPA from a different origin.</p>`,

    `<h2>Security context</h2>
    <p>The image already runs as UID 10001 and needs no capabilities:</p>`,

    DOCS.code(`securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]`, 'backend and worker pods'),

    DOCS.callout('note', 'readOnlyRootFilesystem and screenshots',
      '<p>Chromium writes temporary files. If screenshots are enabled, mount an ' +
      '<code>emptyDir</code> at <code>/tmp</code> alongside a read-only root, or set ' +
      '<code>SCREENSHOT_ENABLED=false</code> and build the image without the Playwright layers.</p>'),

    `<h2>Graceful shutdown</h2>
    <p>Keep <code>terminationGracePeriodSeconds</code> at 45 or more for the worker. That is what the
    drain sequence needs: cancel the five tasks, give in-flight screenshot renders up to 10 seconds,
    close Chromium, then release every lease and delete its own heartbeat row in one transaction.
    Killing it earlier leaves leases held until they expire and a heartbeat row that the next
    worker&rsquo;s startup sweep has to clean up &mdash; recoverable, but noisier than it needs to
    be.</p>`,

    `<h2>A deployment pipeline, if you build one</h2>`,

    DOCS.diagram(`
   Developer
      |
      v
   Git repository
      |
      v
   CI                      no pipeline definition ships with this repo
      |                    a reasonable one would:
      +-- pytest           ~500 tests, SQLite, no services needed
      +-- npm run lint
      +-- npm run build
      +-- docker build backend/  ->  one image, both roles
      +-- docker build frontend/
      |
      v
   Container registry      tag with IMAGE_TAG, or the commit SHA
      |
      v
   Kubernetes
      +---- Job(migrate)          pre-upgrade hook, args ["migrate"]
      +---- Deployment(backend)   args ["api"],    rolling update
      +---- Deployment(worker)    args ["worker"], rolling update
      +---- Deployment(frontend)
      +---- Service x2  +  Ingress
`, 'The test suite needs no PostgreSQL and no Redis - it runs against a throwaway SQLite file - so CI stays cheap.'),

    `<h3>Rolling update behaviour</h3>
    <ul>
      <li><strong>API pods</strong> roll normally. <code>/ready</code> keeps a pod out of the Service
      until the schema is present and seeded, so a pod that starts mid-migration does not serve
      500s.</li>
      <li><strong>Worker pods</strong> roll safely at any surge or unavailability setting. A new
      replica claims work the old one has not; a terminating one releases its leases. There is no
      moment where an endpoint is checked twice or not at all for longer than a lease.</li>
      <li><strong>Migrations must be applied before the new API pods start.</strong> That is the one
      ordering constraint, and it is what the pre-upgrade Job exists for.</li>
    </ul>`,

    DOCS.callout('note', 'What is genuinely untested here',
      '<p>No Kubernetes deployment of this application exists in the repository, so none of the ' +
      'above has been exercised by its test suite or its CI. The probe paths, the entrypoint roles, ' +
      'the worker identity model and the shutdown sequence are all verified in code and by tests; ' +
      'how they compose into a chart is not.</p>')

  ].join('\n')
});
