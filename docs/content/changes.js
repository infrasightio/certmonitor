DOCS.page({
  id: 'changes',
  title: 'Change management',
  description: 'Approval before production, a trustworthy record of who deployed what, and automatic coordination between deployments and monitoring.',
  body: [

    `<h2>Scope</h2>
    <p>Deliberately small. The feature exists to give a team three things, and anything resembling a
    full ITSM workflow is intentionally absent:</p>

    <ol>
      <li>Approval before a production deployment.</li>
      <li>A trustworthy record of who deployed what and when.</li>
      <li>Automatic coordination between deployments and endpoint monitoring.</li>
    </ol>`,

    `<h2>State machine</h2>`,

    DOCS.diagram(`
                        POST /changes
                             |
                             v
                       +-----------+
                       |   DRAFT   |<---- PUT /changes/{id}  (edit)
                       +-----+-----+
                             |
                    POST /changes/{id}/submit
                             |
          environment in change_approval_environments?
                             |
              yes  +---------+---------+  no
                   v                   v
        +--------------------+   (auto-approved, with an
        |  PENDING_APPROVAL  |    "Approved" activity entry
        +----+----------+----+    explaining why)
             |          |              |
   /approve  |          | /reject      |
             |          v              |
             |    +-----------+        |
             |    | REJECTED  |        |
             |    +-----------+        |
             v                         |
        +----------+                   |
        | APPROVED |<------------------+
        +----+-----+
             |
   POST /changes/{id}/start-deployment
   - status must be APPROVED
   - no other active deployment for this application + environment
   - deployer taken from the SESSION
   - the affected endpoints are PAUSED
             |
             v
   +-------------------------+
   | DEPLOYMENT_IN_PROGRESS  |  monitoring is paused for the whole window
   +----+---------------+----+
        |               |
  /complete        /fail (a reason is required)
        |               |
        v               v
  +-----------+   +-----------+
  | COMPLETED |   |  FAILED   |
  +-----------+   +-----------+
        |               |
        +-------+-------+
                |
     monitoring RESUMED for exactly the endpoints this change paused,
     then an immediate health check if change_health_check_on_resume

  /cancel is available from any non-terminal state EXCEPT
  DEPLOYMENT_IN_PROGRESS - complete it or mark it failed instead, so
  monitoring resumes.

  Terminal: COMPLETED, FAILED, CANCELLED, REJECTED.
`, 'Every transition writes a ChangeActivity row, which is what makes the timeline a record rather than a reconstruction.'),

    `<h2>Rules enforced in the service</h2>`,

    DOCS.table(['Rule', 'Message when violated'], [
      ['Only a draft can be submitted',
       '&ldquo;only a draft can be submitted (this one is &lsquo;&hellip;&rsquo;)&rdquo;'],
      ['Only a pending change can be approved or rejected',
       '&ldquo;only a change pending approval can be approved&hellip;&rdquo;'],
      ['<strong>You cannot approve your own change request</strong>',
       '&ldquo;you cannot approve your own change request&rdquo;'],
      ['A rejection needs a reason', '&ldquo;a rejection reason is required&rdquo;'],
      ['Only an approved change can be deployed',
       '&ldquo;this change is still awaiting approval&rdquo;, or &ldquo;only an approved change can ' +
       'be deployed&hellip;&rdquo;'],
      ['One deployment at a time per application + environment',
       '&ldquo;&lt;app&gt; / &lt;env&gt; already has a deployment in progress (CHG-&hellip;), started ' +
       'by &lt;who&gt; at &lt;time&gt;.&rdquo;'],
      ['A deployment in progress cannot be cancelled',
       '&ldquo;a deployment in progress cannot be cancelled &mdash; complete it or mark it failed so ' +
       'monitoring resumes&rdquo;'],
      ['Marking a deployment failed needs a reason', '&ldquo;a failure reason is required&rdquo;'],
      ['A change can only be edited before approval',
       '&ldquo;a change in &lsquo;&hellip;&rsquo; can no longer be edited&rdquo;'],
      ['<strong>A high-risk change needs a rollback plan before submission</strong>',
       '&ldquo;a high-risk change needs a rollback plan before it can be submitted&rdquo;']
    ]),

    `<h3>Who may deploy</h3>
    <p>Any holder of <code>change:deploy</code> may <em>start</em> a deployment. <em>Finishing</em>
    one is restricted to the person who started it, or an administrator &mdash; so a deployment cannot
    be closed out by a bystander who does not know whether it worked.</p>

    <p><code>deployer_id</code> and <code>deployer_name</code> are captured from the authenticated
    session at deployment start and are never writable through the API. &ldquo;Who deployed this&rdquo;
    has to be trustworthy.</p>`,

    `<h2>Monitoring coordination</h2>
    <p>This is the part worth being careful about, and the reason the feature earns its place.</p>`,

    DOCS.diagram(`
  START DEPLOYMENT
     for each affected endpoint:
        record was_paused_before on the change_endpoints link row
        if it was NOT already paused:
              is_paused = True
              current_status = paused
              consecutive_failures = 0     <- a deploy-time blip must not
              next_check_at = NULL            count toward the threshold
        pause_reason = "Deployment CHG-YYYY-NNNN"
        paused_by_change_id = this change

  ... the worker's claim query already skips paused endpoints, so NO
      checks run at all during the window. No incidents open, no alerts
      fire, and the window never lands in the uptime figures.
      Historical data is untouched.

  FINISH (complete or fail)
     for each affected endpoint:
        owned = (paused_by_change_id == this change)
        if owned:
              clear pause_reason and paused_by_change_id
        if owned AND NOT was_paused_before:
              is_paused = False
              current_status = unknown
              next_check_at = now
`, 'Two conditions guard the resume: this change must own the pause, and the endpoint must not have been paused beforehand. Without them, completing a deployment would silently resume monitoring an operator had deliberately turned off.'),

    DOCS.callout('warn', 'The safety net',
      '<p>A deployment left running silences its endpoints indefinitely. ' +
      '<code>change_max_pause_minutes</code> (default 240) is the threshold past which an active ' +
      'deployment is flagged as <strong>overrunning</strong> on the change dashboard. It is a flag, ' +
      'not an automatic resume &mdash; nothing force-completes a deployment on your behalf.</p>'),

    `<h3>Post-deployment health check</h3>
    <p>When <code>change_health_check_on_resume</code> is on (the default), the affected endpoints are
    checked immediately as monitoring resumes, rather than waiting for the next scheduled check.</p>

    <ul>
      <li>Bounded at <strong>40 endpoints</strong> and <strong>10 concurrent</strong>, so a change
      touching a large fleet cannot stall the request.</li>
      <li>Results <strong>are recorded</strong>, with <code>checked_by = deploy:CHG-YYYY-NNNN</code>:
      a deployment that broke something should show up in the history straight away.</li>
      <li>Persisted sequentially, because <code>record_check_result</code> mutates the endpoint row and
      may open or close an incident, so it must not run concurrently.</li>
      <li>The capture is replaced too &mdash; which makes it arguably the most useful capture there
      is: what the endpoint returned the moment the deployment finished.</li>
      <li>The summary is stored on <code>changes.health_check</code> and a
      <code>health_check</code> activity entry records &ldquo;<em>n</em> of <em>m</em> endpoint(s)
      healthy&rdquo;.</li>
    </ul>`,

    `<h2>Scheduling conflicts</h2>
    <p>A change is <em>planned</em> long before it is deployed, so two of them can be booked for
    overlapping windows on the same target while both are still drafts. Two questions answer that
    from data a change already carries, so nothing new is stored:</p>

    <ul>
      <li><strong>Same application and environment.</strong> Two teams booking the same production
      service for overlapping hours.</li>
      <li><strong>Shared endpoints.</strong> The stronger signal, because those two changes will
      fight over the same monitoring pause whatever application they claim to belong to.</li>
    </ul>`,

    DOCS.diagram(`
  Change A   Translation API / production   10:00 -> 11:00
  Change B   Translation API / production   10:30 -> 11:30
                                            ^^^^^^^^^^^^^^
  window  = expected_start_at .. + expected_duration_minutes
            (a deployment already running is measured from started_at,
             which is the honest answer once plan and reality diverge)

  overlap = other.start < ours.end  AND  ours.start < other.end

  Half-open: a change ending exactly as the next begins is a clean
  handover, not a clash.
`, 'Candidates are bounded to changes whose expected_start_at falls within the widest window a change can have (1440 minutes), so the scan uses ix_changes_expected_start rather than reading the table. At most 50 are examined.'),

    `<p>Only changes that still represent an intention to deploy are considered &mdash;
    <code>draft</code>, <code>pending_approval</code>, <code>approved</code> and
    <code>deployment_in_progress</code>. A rejected, cancelled, completed or failed change is not
    competing for anything.</p>

    <p>Conflicts are returned on the change detail payload as <code>conflicts[]</code>, each entry
    carrying the other change's reference, title, status, window and a <code>reason</code> naming
    which of the two tests matched. The scan runs on the detail route only, never per row in the
    listing.</p>`,

    DOCS.callout('note', 'Advisory, never a block',
      '<p>Overlapping windows are sometimes exactly what a team intends &mdash; two changes to one ' +
      'application, deliberately batched into a single outage. A rule that refused them would just ' +
      'be worked around, so nothing in the workflow rejects a conflicting change. It is named on ' +
      'the change and the team decides.</p>' +
      '<p>The one genuine block is separate and unchanged: two deployments cannot be ' +
      '<em>in progress</em> for the same application and environment at once, because they would ' +
      'fight over the same monitoring pause. That returns <code>409 Conflict</code>.</p>'),

    DOCS.callout('warn', 'What is not detected',
      '<p>InfraSight does not know which application calls which, so it does not infer dependency ' +
      'conflicts. A change to a service that another service depends on is not flagged unless the ' +
      'two changes share an endpoint or name the same application and environment. Endpoint ' +
      '<em>dependencies</em> exist in the data model and are used by diagnostics, but they are not ' +
      'consulted here &mdash; that would be a guess dressed up as a finding.</p>'),

    `<h2>High-risk changes</h2>
    <p>A change marked <code>high</code> risk cannot be submitted until it says how it would be
    undone. The rule bites at submission rather than creation, because a draft is the requester's
    working copy and should be savable half-finished.</p>

    <p>The reason is returned on the detail payload as <code>submission_blockers[]</code> before the
    user tries, so the UI disables Submit and explains why rather than failing on click. The backend
    enforces it regardless: <code>POST /changes/{id}/submit</code> returns <code>400</code> with
    &ldquo;a high-risk change needs a rollback plan before it can be submitted&rdquo;. Whitespace is
    not a plan.</p>

    <p>Turn it off with <code>change_require_rollback_plan_for_high_risk</code> (default on).</p>`,

    `<h2>Change records</h2>`,

    DOCS.table(['Field', 'Notes'], [
      ['<code>reference</code>',
       'Human-facing, <code>CHG-&lt;year&gt;-&lt;0000&gt;</code>. Derived from the highest existing ' +
       'reference for the year rather than a sequence, so numbering stays readable and gap-free in ' +
       'normal use. The unique constraint is the real guard: creation retries up to five times on ' +
       'collision.'],
      ['<code>title</code>, <code>application</code>, <code>description</code>',
       'All required. Application is free text and indexed.'],
      ['<code>environment_id</code>', 'Optional; decides whether approval is required'],
      ['<code>expected_start_at</code>, <code>expected_duration_minutes</code>',
       'Required. Duration must be 1&ndash;1440 minutes.'],
      ['<code>risk</code>', '<code>low</code>, <code>medium</code> or <code>high</code>'],
      ['<code>rollback_plan</code>, <code>deployment_notes</code>', 'Optional free text'],
      ['<code>requester_name</code>, <code>approver_name</code>, <code>deployer_name</code>',
       'Denormalised alongside the ids, so the record still reads correctly after a user is deleted'],
      ['<code>started_at</code>, <code>completed_at</code>',
       '<code>actual_duration_minutes</code> is derived from the pair'],
      ['<code>health_check</code>', 'The JSON result of the post-deployment check'],
      ['<code>endpoints</code>',
       'Many-to-many through <code>change_endpoints</code>, which also carries ' +
       '<code>was_paused_before</code>']
    ]),

    `<h3>Comments and activity, kept apart</h3>
    <p><code>change_comments</code> is what people wrote. <code>change_activity</code> is what
    happened: <code>created</code>, <code>updated</code>, <code>submitted</code>,
    <code>approved</code>, <code>rejected</code>, <code>deployment_started</code>,
    <code>monitoring_paused</code>, <code>deployment_completed</code>,
    <code>deployment_failed</code>, <code>monitoring_resumed</code>, <code>health_check</code>,
    <code>cancelled</code>, <code>commented</code>.</p>

    <p>They are separate tables so the automatic events stay distinguishable from the human ones.
    Anyone who can see a change can comment on it &mdash; the change record is the team&rsquo;s shared
    conversation, and gating comments behind a role would just push the discussion into chat. Comments
    are capped at 4000 characters.</p>`,

    `<h2>The change dashboard</h2>
    <p><code>GET /api/changes/dashboard</code> returns counts by status, completed and failed today,
    the next ten upcoming approved or pending changes (from two hours ago onward), every active
    deployment, and the overrunning subset.</p>

    <p><code>GET /api/changes/options</code> returns the filter and form options: applications,
    environments, statuses and risks.</p>`,

    `<h2>Permissions</h2>`,

    DOCS.table(['Permission', 'admin', 'approver', 'viewer'], [
      ['<code>change:read</code>', 'yes', 'yes', 'yes'],
      ['<code>change:write</code>', 'yes', 'yes', 'yes'],
      ['<code>change:comment</code>', 'yes', 'yes', 'yes'],
      ['<code>change:approve</code>', 'yes', 'yes', '&mdash;'],
      ['<code>change:deploy</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>change:cancel</code>', 'yes', '&mdash;', '&mdash;']
    ]),

    DOCS.callout('note', 'Everyone who can see a change can raise one',
      '<p>That is deliberate: the change record is the shared conversation, so raising and commenting ' +
      'are open to every role. Only approving, deploying and cancelling are gated &mdash; and an ' +
      'approver can judge a change but cannot deploy it or alter monitoring configuration.</p>'),

    `<h2>Turning the module off</h2>
    <p><code>feature_change_management_enabled</code> hides the module and makes every
    <code>/api/changes/*</code> route answer <strong>403</strong>. The gate is applied on the router
    include, because every route in that module belongs to the feature.</p>`,

    DOCS.callout('warn', 'Disable it with no deployment in flight',
      '<p>A deployment in progress owns a monitoring pause. If the module is switched off while one ' +
      'is running, the routes that would complete it and resume monitoring stop answering. Finish ' +
      'or fail any active deployment first, or resume the affected endpoints manually from the ' +
      'endpoint list.</p>')

  ].join('\n')
});
