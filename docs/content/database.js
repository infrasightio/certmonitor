DOCS.page({
  id: 'database',
  title: 'Database',
  description: 'Twenty-seven tables, what each is responsible for, how they relate, and the indexes and constraints that carry real weight.',
  body: [

    `<h2>Conventions</h2>`,

    DOCS.table(['Convention', 'Detail'], [
      ['Primary keys',
       'UUID for user-facing entities (endpoints, users, tags, environments, notification ' +
       'channels); <code>BIGINT</code> autoincrement for high-volume and append-only tables ' +
       '(results, incidents, alerts, audit logs, changes, RCAs, diagnoses).'],
      ['Timestamps',
       'Always timezone-aware UTC. <code>TimestampMixin</code> supplies <code>created_at</code> ' +
       '(indexed) and <code>updated_at</code>.'],
      ['JSON', '<code>JSONB</code> on PostgreSQL, plain <code>JSON</code> elsewhere &mdash; so the ' +
       'test suite can run on SQLite.'],
      ['Big integers',
       '<code>BIGINT</code> on PostgreSQL, <code>INTEGER</code> on SQLite, because SQLite has no ' +
       'autoincrementing <code>BIGINT</code>. Without this the test suite could not insert ' +
       'monitoring results.'],
      ['Enums',
       'Stored as short strings, <strong>not</strong> native PostgreSQL <code>ENUM</code> types. ' +
       'Adding a value later is then a code change instead of a migration that has to mutate a type ' +
       'under load.'],
      ['Constraint names',
       'An explicit naming convention (<code>ix_</code>, <code>uq_</code>, <code>ck_</code>, ' +
       '<code>fk_</code>, <code>pk_</code>) keeps Alembic autogenerate diffs clean.']
    ]),

    `<h2>Entity relationships</h2>`,

    DOCS.diagram(`
  environments                 tags                       users ----+
      | 1                       | *                         | 1     |
      |                         |                           |       | created_by /
      | *          *            |                           |       | updated_by /
  +--------------------------------+                        |       | acknowledged_by
  |           endpoints            |*----*  (endpoint_tags) |       |
  |  UUID pk                       |                        |       |
  |  url, hostname, port, path     |*----*  endpoint_dependencies   |
  |  current_status, counters      |        (self-referential)      |
  |  ssl_* summary                 |                                |
  |  next_check_at, lease_*        |         roles *----* permissions
  |  paused_by_change_id ----------+----+      (role_permissions)   |
  +----+------+------+------+------+    |                           |
       | 1    | 1    | 1    | 1         |                           |
       |      |      |      |           |                           |
       | *    | *    | *    | 0..2      |                           |
  +---------+ +--------------+ +------------+ +------------------+  |
  |monitoring| |ssl_          | | incidents  | | endpoint_captures|  |
  |_results  | |certificates  | |            | | pk (endpoint_id, |  |
  |          | | is_current   | | ONE open   | |     outcome)     |  |
  |  bigint  | | fingerprint  | | per endp.  | | body + image     |  |
  +----------+ +--------------+ +-----+------+ +------------------+  |
                                      | 1                            |
                        +-------------+-------------+                |
                        | 1                         | *              |
                   +---------+              +------------------+     |
                   |  rcas   |              | incident_comments|     |
                   | UNIQUE  |              +------------------+     |
                   | incident_id |                                   |
                   | owner_user_id -----------------------------------+
                   +---------+
                        ^
                        | (soft link: rcas.diagnosis_id, rcas.change_id
                        |  are plain bigints, not foreign keys)
                        |
   +----------+   +-----------+   +-------------+   +-------------+
   | diagnoses|   |  alerts   |   |   changes   |   | change_     |
   | endpoint |   | endpoint  |   |  reference  |*-*| activity /  |
   | verdict  |   | incident  |   |  status     |   | comments    |
   | candidates|  | severity  |   +------+------+   +-------------+
   +----------+   +-----------+          | *
                                         |     (change_endpoints,
                                         *      + was_paused_before)
                                     endpoints

  Standalone:  users, roles, permissions, system_settings, audit_logs,
               notification_channels, branding_assets,
               worker_heartbeats, vantage_status
`, 'Solid lines are foreign keys. rcas.diagnosis_id and rcas.change_id are deliberately plain bigints: the RCA must survive the retention sweep deleting what it referenced.'),

    `<h2>Core tables</h2>`,

    DOCS.table(['Table', 'Responsible for', 'Grows with'], [
      ['<code>endpoints</code>',
       'The definition <em>and</em> the live state of one monitored target: configuration, ' +
       'thresholds, counters, current status, certificate summary, scheduling and lease.',
       'The size of the fleet'],
      ['<code>monitoring_results</code>',
       'One row per executed check. <strong>The highest-volume table in the system.</strong>',
       'Check volume &mdash; roughly 1.4 million rows a day for a thousand endpoints on a ' +
       '60-second interval'],
      ['<code>ssl_certificates</code>',
       'One row per distinct certificate observed per endpoint. <code>is_current</code> marks the ' +
       'latest; the rest are the rotation history.',
       'Certificate renewals'],
      ['<code>incidents</code>', 'One row per continuous outage.', 'Outages'],
      ['<code>alerts</code>', 'One row per notification-worthy event, plus its delivery bookkeeping.',
       'Events, damped by the cooldown'],
      ['<code>endpoint_captures</code>',
       'What the endpoint returned, the last time it passed and the last time it failed.',
       '<strong>Nothing</strong> &mdash; exactly two rows per endpoint, ever'],
      ['<code>diagnoses</code>', 'The conclusion of one Diagnose run.', 'Manual diagnoses'],
      ['<code>worker_heartbeats</code>', 'Liveness and self-reported resource use, one row per live worker.',
       'Nothing &mdash; dead rows are retired'],
      ['<code>vantage_status</code>', 'Where each configured vantage point last came out.',
       'Nothing &mdash; one row per configured vantage']
    ]),

    `<h3>endpoints: the columns that drive behaviour</h3>`,

    DOCS.table(['Column', 'Purpose'], [
      ['<code>protocol</code>, <code>hostname</code>, <code>port</code>, <code>path</code>',
       'Parsed from <code>url</code> once at write time, so the SSL page and every filter can query ' +
       'on host without re-parsing thousands of URLs per request'],
      ['<code>next_check_at</code>', 'The scheduler’s cursor. NULL means never scheduled or paused.'],
      ['<code>lease_expires_at</code>, <code>leased_by</code>',
       'Set while a worker holds the row, so a crashed worker’s endpoint becomes claimable again'],
      ['<code>consecutive_failures</code>, <code>consecutive_successes</code>',
       'Drive the incident threshold and the recovery threshold'],
      ['<code>total_checks</code>, <code>total_failures</code>',
       'Lifetime counters, exposed as <code>uptime_ratio</code>. Note this is lifetime, not ' +
       'windowed &mdash; the dashboard computes windowed uptime from ' +
       '<code>monitoring_results</code> instead.'],
      ['<code>resolved_health_path</code>',
       'A path found by discovery. Kept separate from <code>url</code> so the operator’s ' +
       'configuration is never rewritten behind their back.'],
      ['<code>pause_reason</code>, <code>paused_by_change_id</code>',
       'Why monitoring is paused and which change owns the pause &mdash; so a deployment pause is ' +
       'only ever lifted by the change that applied it'],
      ['<code>auth_secret_encrypted</code>, <code>auth_secret_hint</code>',
       'The Fernet-encrypted credential, and a display-safe mask'],
      ['<code>last_vantage_check</code>, <code>last_vantage_check_at</code>',
       'The record of &ldquo;we were about to page you, and here is what everywhere else saw&rdquo;. ' +
       'Kept on the endpoint rather than in a table of its own because only the latest one has ever ' +
       'been worth reading.']
    ]),

    `<h2>Indexes that carry weight</h2>`,

    DOCS.table(['Index', 'On', 'Why it exists'], [
      ['<code>ix_endpoints_due</code>',
       '<code>(monitoring_enabled, is_paused, next_check_at)</code>',
       '<strong>The scheduler’s hot query.</strong> Every worker cycle runs it.'],
      ['<code>ix_endpoints_status_env</code>', '<code>(current_status, environment_id)</code>',
       'Dashboard status counts and the environment filter'],
      ['<code>ix_endpoints_ssl_expiry</code>', '<code>ssl_expires_at</code>',
       'The certificate expiry timeline and the expiring-within filter'],
      ['<code>ix_monitoring_results_endpoint_time</code>',
       '<code>(endpoint_id, checked_at)</code>',
       'Per-endpoint history and the latency series'],
      ['<code>ix_monitoring_results_checked_at</code>', '<code>checked_at</code>',
       'Global aggregates, and the retention sweep’s cutoff scan'],
      ['<code>uq_incidents_one_open_per_endpoint</code>',
       '<code>endpoint_id</code> <em>partial</em>, <code>WHERE status = \'open\'</code>',
       '<strong>The guarantee behind &ldquo;four failed checks are one incident&rdquo;.</strong> ' +
       'Declared with both <code>postgresql_where</code> and <code>sqlite_where</code>, so the test ' +
       'suite exercises the same constraint.'],
      ['<code>ck_endpoint_captures_outcome</code>',
       '<code>outcome IN (\'success\', \'failure\')</code>',
       'With the composite primary key, this is what makes two rows per endpoint a structural ' +
       'guarantee rather than a policy'],
      ['<code>ck_endpoint_dependencies_not_self</code>',
       '<code>endpoint_id &lt;&gt; depends_on_endpoint_id</code>',
       'An endpoint cannot depend on itself'],
      ['<code>uq_rcas_incident_id</code>', '<code>rcas.incident_id</code>',
       'One RCA per incident, enforced by the database so a double-click cannot create two'],
      ['<code>uq_changes_reference</code>', '<code>changes.reference</code>',
       'The real guard on reference allocation; creation retries on collision']
    ]),

    `<h2>Cascade behaviour</h2>`,

    DOCS.table(['Deleting', 'Cascades to', 'Sets NULL on'], [
      ['An <strong>endpoint</strong>',
       '<code>monitoring_results</code>, <code>ssl_certificates</code>, <code>incidents</code> ' +
       '(and therefore <code>rcas</code> and <code>incident_comments</code>), ' +
       '<code>endpoint_captures</code>, <code>diagnoses</code>, <code>alerts</code>, ' +
       '<code>endpoint_tags</code>, <code>endpoint_dependencies</code>, <code>change_endpoints</code>',
       '&mdash;'],
      ['An <strong>incident</strong>', '<code>rcas</code>, <code>incident_comments</code>',
       '<code>alerts.incident_id</code>'],
      ['A <strong>change</strong>', '<code>change_activity</code>, <code>change_comments</code>, ' +
       '<code>change_endpoints</code>', '<code>endpoints.paused_by_change_id</code>'],
      ['A <strong>user</strong>', '&mdash;',
       'Every <code>*_by_id</code> column. Denormalised usernames on audit entries, changes, ' +
       'comments and RCAs are what keep those records readable.'],
      ['An <strong>environment</strong>', '&mdash;',
       '<code>endpoints.environment_id</code>, <code>changes.environment_id</code>'],
      ['A <strong>tag</strong>', '<code>endpoint_tags</code>', '&mdash;'],
      ['A <strong>role</strong>', '<code>role_permissions</code>',
       'Nothing &mdash; <code>users.role_id</code> is <code>ON DELETE RESTRICT</code>, so a role ' +
       'with users cannot be deleted']
    ]),

    `<h2>Supporting tables</h2>`,

    DOCS.table(['Table', 'Responsible for'], [
      ['<code>users</code>, <code>roles</code>, <code>permissions</code>, <code>role_permissions</code>',
       'Identity and RBAC. <code>token_version</code> on the user is what makes session revocation ' +
       'possible without a session store.'],
      ['<code>environments</code>', 'Named environments with optional threshold overrides'],
      ['<code>tags</code>, <code>endpoint_tags</code>', 'Free labelling and a filter dimension'],
      ['<code>endpoint_dependencies</code>', 'Declared dependencies between endpoints, read by Diagnose'],
      ['<code>incident_comments</code>', 'The investigation conversation, and the raw material of the RCA'],
      ['<code>rcas</code>', 'One optional root-cause analysis per incident'],
      ['<code>changes</code>, <code>change_endpoints</code>, <code>change_activity</code>, ' +
       '<code>change_comments</code>',
       'The change workflow. <code>change_endpoints.was_paused_before</code> is the one fact needed ' +
       'to undo a pause correctly.'],
      ['<code>alerts</code>, <code>notification_channels</code>',
       'Events and delivery targets. <code>config_encrypted</code> holds the whole provider config ' +
       'as one encrypted blob; <code>config_public</code> holds only what is safe to display.'],
      ['<code>system_settings</code>',
       'Runtime overrides of the environment defaults, one row per <code>SettingSpec</code>'],
      ['<code>audit_logs</code>',
       'Append-only record of administrative actions, with the username denormalised so the trail ' +
       'survives user deletion'],
      ['<code>branding_assets</code>',
       'The uploaded logo. Held in the database rather than on a volume so it survives a container ' +
       'rebuild and is identical for every replica.']
    ]),

    `<h2>Migrations</h2>
    <p>Alembic, a linear chain of 18 revisions from <code>0001</code> to <code>0018</code>, each
    naming its predecessor as <code>down_revision</code>. There are no branches and no merge
    revisions.</p>`,

    DOCS.table(['Revision', 'Introduced'], [
      ['<code>0001</code>', 'Initial schema'],
      ['<code>0002</code>', 'Change management'],
      ['<code>0003</code>', 'Health-path discovery'],
      ['<code>0004</code>', 'Diagnosis history'],
      ['<code>0005</code>', 'Lightweight RCA management'],
      ['<code>0006</code>', 'Worker resource reporting'],
      ['<code>0007</code>', 'User avatar emoji'],
      ['<code>0008</code>', 'Uploaded logo, and dropping the emoji experiment'],
      ['<code>0009</code>', 'Declared dependencies between endpoints'],
      ['<code>0010</code>', 'Per-result retry count'],
      ['<code>0011</code>', 'Environment-level threshold overrides'],
      ['<code>0012</code>', 'Link attachments on an RCA'],
      ['<code>0013</code>', 'Owner name, and the node the service runs on'],
      ['<code>0014</code>', 'Re-basing the healthy check cadence on five minutes'],
      ['<code>0015</code>', 'Endpoint captures'],
      ['<code>0016</code>', 'Vantage confirmation'],
      ['<code>0017</code>', 'Worker region, and vantage status'],
      ['<code>0018</code>', 'Endpoints can inherit their failure threshold']
    ]),

    DOCS.callout('note', 'Why the history is not squashed',
      '<p>Seventeen numbered files look like accumulated development debris, and the temptation is ' +
      'to collapse them into one baseline. They are not debris: every deployed database records ' +
      'the revision it reached in <code>alembic_version</code>. Replacing the chain with a new ' +
      'baseline would leave those databases pointing at a revision that no longer exists, and ' +
      '<code>alembic upgrade head</code> would fail on the next start.</p>' +
      '<p>A squash is only safe once every database that matters is at <code>head</code> and can ' +
      'be stamped, which is a deployment operation, not a code cleanup. Until then the linear ' +
      'chain <em>is</em> the clean structure: one file per change, each naming its predecessor, ' +
      'no branches, no merge revisions, and a table above that says what each one did.</p>'),

    DOCS.callout('note', 'Who runs migrations',
      '<p>Only the <code>api</code> entrypoint role runs <code>alembic upgrade head</code>. The ' +
      'worker waits for the schema instead &mdash; if both ran them, two containers starting ' +
      'together would race. Alembic uses the sync DSN ' +
      '(<code>postgresql+psycopg2://</code>), derived automatically from ' +
      '<code>DATABASE_URL</code>.</p>'),

    `<h2>Retention</h2>
    <p>Only <code>monitoring_results</code> grows without bound, so it is pruned aggressively.
    Incidents and audit logs are kept far longer because they are the record of what happened, and
    they are small.</p>`,

    DOCS.table(['Table', 'Setting', 'Default', 'Eligible rows'], [
      ['<code>monitoring_results</code>', '<code>data_retention_days</code>', '90 days', 'All, by <code>checked_at</code>'],
      ['<code>ssl_certificates</code>', '<code>data_retention_days</code>', '90 days',
       '<strong>Only superseded ones.</strong> Every <code>is_current</code> row is kept forever.'],
      ['<code>alerts</code>', '<code>alert_retention_days</code>', '180 days', 'All, by <code>created_at</code>'],
      ['<code>incidents</code>', '<code>incident_retention_days</code>', '730 days',
       '<strong>Only resolved ones.</strong> An open incident is current state, not history.'],
      ['<code>audit_logs</code>', '<code>audit_retention_days</code>', '365 days', 'All, by <code>created_at</code>']
    ]),

    `<p>Deletes run in batches of 5000, committing between batches and capped at 200 batches per table
    per sweep, so the sweep never holds a long transaction or a table-wide lock while the worker is
    trying to write results. It is safe to run concurrently on several replicas.</p>`,

    DOCS.callout('warn', 'Nothing prunes diagnoses, RCAs, changes or captures',
      '<p><code>run_retention_sweep</code> covers five tables and no others. ' +
      '<code>endpoint_captures</code> needs no sweep &mdash; its primary key bounds it at two rows ' +
      'per endpoint. <code>diagnoses</code>, <code>rcas</code>, <code>changes</code> and their ' +
      'children accumulate, but they grow with human activity rather than with check volume, which ' +
      'is a rate several orders of magnitude lower.</p>'),

    `<h2>Connection pooling</h2>
    <p>One pooled async engine per process, sized independently through the <code>DB_POOL_*</code>
    settings. The Compose file gives the worker a smaller pool than the API
    (<code>WORKER_DB_POOL_SIZE</code>, default 10, versus <code>DB_POOL_SIZE</code>, default 10 with
    <code>DB_MAX_OVERFLOW</code> 20) because the worker holds one short transaction per check rather
    than one per request. <code>pool_pre_ping</code> is on, and <code>pool_recycle</code> defaults to
    1800 seconds.</p>

    <p>PostgreSQL is started with <code>max_connections=200</code>, <code>shared_buffers=256MB</code>,
    <code>effective_cache_size=768MB</code>, <code>work_mem=8MB</code> and
    <code>log_min_duration_statement=1000</code> &mdash; anything slower than a second is logged,
    because the statistics queries are the first thing to degrade as history grows.</p>`,

    `<h2>Backups</h2>
    <p>Everything durable is in PostgreSQL, including the uploaded logo, so a database dump is a
    complete backup. In the bundled topology the port is published on loopback only, for exactly this
    purpose.</p>`,

    DOCS.code(`# Dump
docker compose exec -T postgres pg_dump -U infrasight -d infrasight \\
  --format=custom --file=/tmp/infrasight.dump
docker compose cp postgres:/tmp/infrasight.dump ./infrasight-$(date +%F).dump

# Restore into an empty database
docker compose cp ./infrasight-2026-09-16.dump postgres:/tmp/restore.dump
docker compose exec -T postgres pg_restore -U infrasight -d infrasight \\
  --clean --if-exists /tmp/restore.dump`, 'shell'),

    DOCS.callout('danger', 'A dump is not enough on its own',
      '<p>Endpoint credentials and notification-channel configuration are encrypted with a key ' +
      'derived from <code>ENCRYPTION_KEY</code> or <code>JWT_SECRET</code>. Restoring a dump without ' +
      'the matching key leaves every one of those values undecryptable. Back up the key material ' +
      'alongside the dump, and keep it somewhere the dump is not.</p>')

  ].join('\n')
});
