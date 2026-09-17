DOCS.page({
  id: 'request-flow',
  title: 'Request and data flow',
  description: 'What actually happens between a browser action and a database row, traced through the real call chain for each major path.',
  body: [

    `<h2>The general shape</h2>
    <p>Every authenticated API call follows the same path. The layers are real modules, not an
    aspiration.</p>`,

    DOCS.diagram(`
  Browser (React)
     |  axios instance, baseURL "/api", Authorization: Bearer <access>
     v
  nginx  (frontend container)
     |  location /api/  ->  http://backend:8000
     |  adds X-Real-IP, X-Forwarded-For, X-Forwarded-Proto, X-Request-ID
     v
  SecurityHeaders -> RequestContext -> GZip [-> CORS] [-> TrustedHost]
     |
     v
  Route handler                       app/api/routes/<resource>.py
     |
     +-- Depends(get_current_user)     decode JWT, load user, compare tv claim
     +-- Depends(get_active_user)      refuse if must_change_password
     +-- Depends(require_permissions)  403 if the role lacks a code
     +-- Depends(get_db)               one AsyncSession for this request
     +-- Depends(runtime_config)       effective settings map (10s cache)
     |
     v
  Service                             app/services/<domain>_service.py
     |  business rules, raises a typed error the route maps to a status
     v
  SQLAlchemy ORM -> asyncpg -> PostgreSQL
     |
     v
  audit_service.record(...)           for every administrative mutation
     |
     v
  session.commit()
     |
     v
  Pydantic response model -> JSON
     |  + X-Request-ID, X-Response-Time-Ms, security headers
     v
  Browser
`, 'The session is created per request by get_db and rolled back on any exception before the error handler runs.'),

    `<h2>Authentication</h2>

    <h3>Sign-in</h3>`,

    DOCS.diagram(`
  POST /api/auth/login  {username, password}
     |
     +-- check_login_rate_limit("ip:<addr>")     LOGIN_RATE_LIMIT_ATTEMPTS
     +-- check_login_rate_limit("user:<name>")   in LOGIN_RATE_LIMIT_WINDOW_SECONDS
     |      either over the limit -> audit login_failed (rate_limited)
     |                            -> 429 with Retry-After
     v
  user_service.authenticate(session, username, password, config)
     |
     +-- user missing?  verify against a throwaway hash first (timing equaliser),
     |                  then raise the SAME generic error as a wrong password
     +-- locked_until in the future?  -> AccountLocked -> 423
     +-- wrong password?  failed_login_attempts += 1
     |                    at account_lockout_attempts -> locked_until = now + N min
     |                    -> 401
     +-- inactive?  -> 401 "This account is disabled."
     +-- success:   clear counters, rehash if the bcrypt cost was raised
     v
  note_login()  ->  clear both rate-limit keys  ->  audit login  ->  commit
     v
  _issue_tokens(user, config)
        access  : exp = session_timeout_minutes (setting) or ACCESS_TOKEN_EXPIRE_MINUTES
        refresh : exp = session_refresh_days   (setting) or REFRESH_TOKEN_EXPIRE_DAYS
        claims  : sub, type, iat, exp, jti, tv, role
     v
  200 {access_token, refresh_token, expires_in, expires_at,
       must_change_password, user{..., permissions[]}}
`, 'The same response for an unknown username and a wrong password is deliberate: accounts cannot be enumerated. Lockout is reported distinctly, because the user genuinely needs to know why waiting is required.'),

    `<h3>Authorising a subsequent request</h3>
    <p><code>get_current_user</code> decodes the bearer token, requires the <code>exp</code>,
    <code>sub</code> and <code>type</code> claims, and loads the user. The decisive check is the
    <code>tv</code> claim against <code>users.token_version</code>:</p>`,

    DOCS.code(`if int(payload.get("tv", 0)) != int(user.token_version or 0):
    raise HTTPException(401, "Session is no longer valid. Please sign in again.")`,
      'app/api/deps.py'),

    `<p>Bumping <code>token_version</code> invalidates every token already issued for that user,
    without a server-side session store. A password change, an administrative password reset, a role
    change or a disable therefore takes effect immediately rather than at token expiry.</p>`,

    DOCS.callout('note', 'What a shorter session timeout can and cannot do',
      '<p>Lowering <code>session_timeout_minutes</code> in Settings applies to sessions created from ' +
      'then on. A token already in a browser carries its own expiry and the setting cannot reach ' +
      'back and revoke it. Bumping <code>token_version</code> is what does that &mdash; which is ' +
      'what a password reset or a role change already does.</p>'),

    `<h3>Token refresh</h3>
    <p>On any 401 that is not itself an <code>/auth/</code> call, the axios interceptor sets
    <code>config._retried</code>, calls <code>POST /api/auth/refresh</code> through a shared promise,
    and replays the original request with the new token. If the refresh fails the token store is
    cleared and the session-expired handler signs the user out locally.</p>`,

    `<h2>A scheduled check, end to end</h2>
    <p>This is the path that produces almost every row in the database.</p>`,

    DOCS.diagram(`
  worker: _check_loop  ->  _run_cycle  ->  _claim_due_endpoints  ->  gather
     |
     v
  _check_and_record(endpoint_id, config)          own session, own transaction
     |
     +-- reload the endpoint with tags + environment
     +-- still enabled and unpaused?  no -> clear lease, next_check_at = NULL, return
     |
     +-- monitoring_service.execute_check(endpoint, config)
     |      |
     |      +-- resolve_thresholds()   endpoint -> environment -> setting -> default
     |      +-- decrypt_secret(auth_secret_encrypted)
     |      |      None -> record a config_error outcome and stop here
     |      +-- build_target_from_endpoint()  -> CheckTarget
     |      +-- checker.run_check(target)     -> CheckOutcome      [no database]
     |
     +-- _vantage_gate(endpoint, outcome, config)
     |      only when: the check failed, vantages are configured, and this is
     |      EXACTLY the failure that reaches failure_threshold
     |      -> returns a reason to withhold the incident, or None
     |
     +-- monitoring_service.record_check_result(...)
     |      INSERT monitoring_results
     |      UPDATE endpoints   last_*, counters, current_status, ssl_*
     |      UPSERT ssl_certificates (new row when the fingerprint changed)
     |      INSERT/UPDATE/CLOSE incidents
     |      INSERT alerts  ->  notification_service.dispatch_alert
     |
     +-- capture_service.record_check(...)
     |      REPLACE the (endpoint_id, outcome) capture row - body, headers,
     |      timing. Same transaction as the result it describes.
     |
     +-- finally: next_check_at = next_check_for(endpoint, config)
     |            lease_expires_at = NULL, leased_by = NULL
     |
     +-- COMMIT
     |
     +-- if wanted: spawn a screenshot render  (after the commit, never inside it)
`, 'The reschedule is in a finally block, so even a failure during recording re-arms the schedule instead of leaving the endpoint to be retried in a tight loop.'),

    DOCS.callout('note', 'Why the capture shares the transaction but the screenshot does not',
      '<p>The capture is written in the same transaction as the result it describes, so the two ' +
      'commit together or not at all &mdash; a capture can never claim to be the body of a check ' +
      'that was never recorded. A screenshot takes seconds to render; doing it inside the ' +
      'transaction would hold a row lock and a connection open for the duration, so it runs after ' +
      'the commit as a tracked background task.</p>' +
      '<p>The price is that the render is a <em>second request</em>, made seconds later and ' +
      'answered by the endpoint on its own terms. On a flapping endpoint it lands on the other ' +
      'side of the line often enough to matter: the browser gets a 504 while the check that ' +
      'triggered it got 200, or a healthy page while the check timed out. So the render&rsquo;s ' +
      'own HTTP status is carried back with the image and compared against the row it would be ' +
      'filed under, using the endpoint&rsquo;s expected status codes. If they disagree the image ' +
      'is dropped and the reason is stored in its place &mdash; a picture of a different response ' +
      'is worse than no picture, which is the same rule that clears the old screenshot when a ' +
      'capture is replaced.</p>'),

    `<h2>A manual check</h2>
    <p><code>POST /api/endpoints/{id}/check</code> runs the same probe from the API process, which is
    what makes it trustworthy as a test.</p>`,

    DOCS.diagram(`
  POST /api/endpoints/{id}/check?persist=true|false      needs endpoint:check
     |
     +-- monitoring_service.execute_check()      the identical code path
     |
     +-- persist=false  ->  return the outcome, write nothing
     |                      (a configuration dry run)
     |
     +-- persist=true   ->  record_check_result(is_manual=True,
     |                                          checked_by=<username>)
     |                      capture_service.record_check(...)
     |                      next_check_at = next_check_for(...)
     |                      audit endpoint_checked
     v
  CheckNowResponse
`, 'is_manual on the monitoring_results row is what distinguishes an operator-triggered probe from the worker’s own.'),

    `<h2>Loading the dashboard</h2>
    <p>One request answers the whole screen, so the cards, charts and incident list are guaranteed to
    describe the same moment in time.</p>`,

    DOCS.diagram(`
  GET /api/dashboard?window=24h&environment=..&tag=..&status=..
     |
     v
  _in_parallel(five branches)      each opens its OWN AsyncSession
     |
     +-- summary      stats_service.dashboard_summary()
     +-- series       filtered_endpoint_ids() -> global_response_time_series()
     +-- groups       availability_by_group() x environment, tag, team
     +-- ranking      ssl_expiry_timeline() + failure_counts() + slowest_endpoints()
     +-- incidents    recent_incidents(open_only=True) + recent_incidents(all)
     |
     v
  sla_breaches(by_environment, target=uptime_sla_target)
     v
  DashboardResponse   generated_at + every block above
`, 'About twenty aggregate queries over one window. Awaiting them serially made opening the dashboard feel broken; five concurrent branches make wall time the slowest branch rather than the sum.'),

    DOCS.callout('warn', 'Why five sessions and not one',
      '<p>A single <code>AsyncSession</code> cannot serve overlapping queries and raises as soon as ' +
      'two land together. Five branches is deliberate rather than one session per query: it keeps ' +
      'the connection cost of a dashboard load bounded and well inside the pool.</p>'),

    `<h2>Starting a deployment</h2>`,

    DOCS.diagram(`
  POST /api/changes/{id}/start-deployment          needs change:deploy
     |
     +-- feature gate: feature_change_management_enabled  (403 if off)
     +-- status must be APPROVED
     +-- active_deployment_for(application, environment)  -> DuplicateDeployment
     |
     +-- status = deployment_in_progress
     +-- deployer_id / deployer_name from the SESSION, never the request body
     +-- started_at = now
     |
     +-- _pause_endpoints()
     |      for each affected endpoint:
     |        remember was_paused_before on the change_endpoints link row
     |        if it was not already paused:
     |             is_paused = True
     |             current_status = paused
     |             consecutive_failures = 0        <- a deploy-time blip must not
     |             next_check_at = NULL               count toward the threshold
     |        pause_reason = "Deployment CHG-...."
     |        paused_by_change_id = <this change>
     |
     +-- record_activity(deployment_started), record_activity(monitoring_paused)
     v
  DeploymentResult
`, 'The worker’s claim query already skips paused endpoints, so no checks run at all while a deployment is in flight: no incidents open, no alerts fire, and the window never lands in the uptime figures.'),

    `<h2>Requesting and completing an RCA</h2>`,

    DOCS.diagram(`
  POST /api/incidents/{id}/rca        needs incident:write, feature_rca_enabled
     |
     +-- rca_service.request_rca()
     |      idempotent - an existing open RCA is returned, not duplicated
     |      denormalises endpoint name, application, environment onto the row
     |      status = pending, requested_by/_at set
     |      due_at = now + rca_default_due_days, when that setting is non-zero
     v
  POST /api/rca/{id}/draft
     |
     +-- rca_draft.gather_evidence(session, incident)
     |      monitoring results during the outage, failure reasons, HTTP codes,
     |      the preceding change, the stored diagnosis, incident comments
     +-- rca_draft.build_draft() + build_timeline()
     v
  PUT /api/rca/{id}          save partial work; saving never completes it
     v
  POST /api/rca/{id}/complete
     +-- requires a non-empty root_cause AND resolution
     +-- status = completed, completed_at/_by set
     +-- the INCIDENT is deliberately untouched
`, 'The two lifecycles are independent by design. An incident can be resolved and closed with its RCA still at Pending.'),

    `<h2>Bulk import</h2>
    <p>Validate, then confirm. Nothing is written during analysis, so a bad file cannot leave half an
    import behind.</p>`,

    DOCS.diagram(`
  POST /api/import              multipart file, needs endpoint:import
     |
     +-- size <= MAX_UPLOAD_BYTES
     +-- read_file()            CSV or XLSX, header aliases normalised
     +-- a "url" column is required, or the file is rejected outright
     +-- rows <= MAX_IMPORT_ROWS (5000)
     +-- parse_row() per row, numbering from 2 so it matches the spreadsheet
     +-- _detect_duplicates()   against the database AND within the file
     +-- preview_store.save()   Redis when available, else in-process, TTL 900s
     v
  ImportPreviewResponse {token, rows[{row_number, errors[], warnings[], ...}]}
     |
     v
  POST /api/import/confirm     {token, row_numbers?}
     |
     +-- commit() creates only the confirmed, valid rows,
     |   each inside its own SAVEPOINT so one late failure does not
     |   discard the rows that already succeeded
     v
  ImportResultResponse {created[], failed[], skipped[]}
`, 'With Redis unavailable the preview lives in-process, so the confirm request must reach the same replica. Compose runs a single API container; see the Kubernetes notes for the multi-replica case.'),

    `<h2>Serving the SPA</h2>`,

    DOCS.diagram(`
  GET /                     -> try_files $uri $uri/ /index.html
                               Cache-Control: no-store, must-revalidate
                               (never cache index.html, or a deploy leaves
                                clients on the old asset manifest)

  GET /assets/<hash>.js     -> expires 1y, Cache-Control: public, immutable
                               (Vite emits content-hashed filenames)

  GET /api/...              -> proxy_pass http://backend:8000
                               proxy_buffering off, read timeout 120s
                               (manual checks and large imports take a while)

  GET /health|/ready|/live  -> proxied, access_log off, read timeout 10s
  GET /branding[/logo]      -> proxied; unauthenticated, read before sign-in

  GET /docs/...             -> the documentation site, copied into the image
                               try_files ... /docs/index.html (hash routing)
                               Cache-Control: no-cache
  GET /docs                 -> 301 /docs/

  GET /healthz              -> nginx answers "ok" itself, no upstream
`, 'One origin for everything - the app, the API, the probes and the documentation - which removes CORS from the picture and matches how the app is expected to sit behind an ingress.')

  ].join('\n')
});
