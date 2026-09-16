DOCS.page({
  id: 'rca',
  title: 'Root cause analysis',
  description: 'The optional post-incident workflow: ownership by person or team, a draft assembled from stored evidence, and analytics over recurring causes.',
  body: [

    DOCS.callout('note', 'The governing rule',
      '<p><strong>RCA is optional and never blocks anything.</strong> It does not gate incident ' +
      'resolution, incident closure, deployment completion or monitoring restoration. An incident ' +
      'can be resolved and closed with its RCA at Pending, and completing an RCA changes nothing ' +
      'about the incident. A process that holds up recovery for paperwork is a process people learn ' +
      'to route around &mdash; and then the paperwork stops happening at all.</p>'),

    `<h2>Lifecycle</h2>
    <p>Five states, deliberately parallel to and independent of the incident lifecycle.</p>`,

    DOCS.diagram(`
                         an incident exists
                                |
              +-----------------+------------------+
              |                                    |
   POST /incidents/{id}/rca            POST /incidents/{id}/rca/not-required
              |                                    |
              v                                    v
      +----------------+                   +----------------+
      |    PENDING     |                   |  NOT_REQUIRED  |
      +-------+--------+                   +--------+-------+
              |                                     |
      first save / explicit start                   |
              |                                     |
              v                                     |
      +----------------+                            |
      |  IN_PROGRESS   |                            |
      +-------+--------+                            |
              |                                     |
   POST /rca/{id}/complete                          |
   requires BOTH a root cause                       |
   and a resolution                                 |
              |                                     |
              v                                     |
      +----------------+                            |
      |   COMPLETED    |                            |
      +-------+--------+                            |
              |                                     |
              +------------+------------------------+
                           |
              POST /rca/{id}/reopen   ADMINISTRATORS ONLY
                           |
                           v
                    IN_PROGRESS again
             (the previous close is written to the timeline
              before it is cleared, so the record still shows
              it was signed off once, and by whom)

  NOT_REQUESTED exists as a value but is not a state an RCA is created in:
  it marks a row that was never actually requested.
`, 'Saving content never completes an RCA. Partial work is normal - one written over three days by two people is the common case, not the exception.'),

    `<h2>Ownership</h2>
    <p>An RCA belongs to <strong>one person or one team</strong>, never both. Setting one clears the
    other.</p>`,

    DOCS.table(['owner_type', 'Fields set', 'Fields cleared'], [
      ['<code>individual</code>', '<code>owner_user_id</code>, <code>owner_user_name</code>',
       '<code>owner_team</code>'],
      ['<code>team</code>', '<code>owner_team</code>',
       '<code>owner_user_id</code>, <code>owner_user_name</code>']
    ]),

    DOCS.callout('tip', 'Teams are the labels that already exist',
      '<p>A team is the same free-text label already used on endpoints and on users. A team table ' +
      'plus a membership screen would be a migration and two more pages without answering a single ' +
      'question the string cannot. Matching is case-insensitive and whitespace-trimmed.</p>'),

    `<h3>Permissions, without new roles</h3>`,

    DOCS.table(['Action', 'Who'], [
      ['Read', 'Anyone with <code>incident:read</code> &mdash; which every role holds'],
      ['Request, assign, mark not required',
       '<code>incident:write</code>, or an administrator. Assigning is a management action.'],
      ['Edit and complete',
       'An administrator, anyone with <code>incident:write</code>, <strong>or the assigned ' +
       'owner</strong> &mdash; a person whose id matches, or anyone whose team label matches'],
      ['Reopen',
       '<strong>Administrators only</strong>, and only something already closed']
    ]),

    DOCS.callout('warn', 'Why reopening is narrower than editing',
      '<p>Completing an RCA is a sign-off. If anyone who could edit it could also quietly un-sign ' +
      'it, the completed state would be worth nothing. Owner-based editing is what makes team ' +
      'ownership work in the first place: a viewer assigned an RCA can complete it, which is the ' +
      'whole point of assigning it to them.</p>'),

    `<h2>What an RCA record holds</h2>`,

    DOCS.table(['Field', 'Content'], [
      ['<code>incident_id</code>',
       'Unique &mdash; one RCA per incident, enforced by a constraint rather than by application ' +
       'code, so a double-click cannot create two'],
      ['<code>endpoint_name</code>, <code>application</code>, <code>environment</code>',
       'Denormalised at creation, so the RCA list needs no joins and still reads correctly after an ' +
       'endpoint is renamed or deleted'],
      ['<code>root_cause</code>, <code>root_cause_category</code>',
       'The finding, and an optional classification from twelve categories'],
      ['<code>impact</code>, <code>resolution</code>', 'What it affected, and what fixed it'],
      ['<code>preventive_actions</code>',
       'A JSON list of <code>{text, done}</code> &mdash; several small tickable actions beat one ' +
       'paragraph nobody can tick off'],
      ['<code>timeline</code>',
       '<code>{at, kind, detail, source}</code>, seeded from real events and then editable'],
      ['<code>attachments</code>',
       '<code>{id, label, url, added_at, added_by}</code> &mdash; a <em>link</em> to wherever the ' +
       'document already lives (Drive, OneDrive, SharePoint), not a file InfraSight stores'],
      ['<code>diagnosis_id</code>, <code>change_id</code>',
       'What the diagnosis engine concluded at the time, and any correlated deployment &mdash; kept ' +
       'so the RCA still shows its evidence after the endpoint has long since recovered'],
      ['<code>due_at</code>',
       'Optional. An RCA without a deadline is never overdue &mdash; it simply has no deadline.'],
      ['<code>not_required_reason</code>',
       'Why analysis was declined. &ldquo;We looked and decided not to&rdquo; is a different state ' +
       'from &ldquo;nobody has looked&rdquo;, and only the first should disappear from the pending ' +
       'queue.']
    ]),

    `<h3>Root-cause categories</h3>
    <p>The value of a category is entirely in aggregation &mdash; &ldquo;34% of our outages are
    deployment-related&rdquo; is actionable in a way that thirty individual write-ups are not.</p>

    <p><code>application</code>, <code>infrastructure</code>, <code>network</code>,
    <code>database</code>, <code>deployment</code>, <code>configuration</code>, <code>ssl_tls</code>,
    <code>security</code>, <code>dependency</code>, <code>human_error</code>,
    <code>external_dependency</code>, <code>unknown</code>.</p>`,

    `<h2>The draft</h2>
    <p><code>POST /api/rca/{id}/draft</code> assembles a starting point from data InfraSight already
    holds. Nothing is sent anywhere and nothing is generated by a model.</p>`,

    DOCS.diagram(`
  rca_draft.gather_evidence(session, incident)
     |
     +-- the endpoint, and its environment and application
     +-- monitoring_results spanning the outage
     |     -> HTTP status codes seen, failure reasons seen, the first error
     |     -> how many checks failed
     +-- the latency baseline before the outage
     +-- similar incidents in the last 90 days, and how many shared this reason
     +-- the deployment that completed most recently before the outage began,
     |   and how many minutes before
     +-- the stored diagnosis, with its verdict, confidence and candidates
     +-- every incident comment
     |
     v
  build_draft()     prose for root cause / impact / resolution
  build_timeline()  ordered events from the evidence above
     |
     v
  a draft the owner EDITS. Nothing is saved until they save it.
`, 'The incident comment thread is the raw material here - which is why keeping the conversation on the incident rather than in chat matters.'),

    `<h2>Analytics</h2>
    <p><code>GET /api/rca/analytics</code> aggregates over a window, 90 days by default.</p>`,

    DOCS.table(['Question', 'Answered by'], [
      ['What causes our outages?', 'Counts by <code>root_cause_category</code>'],
      ['Which problems keep coming back?',
       '<code>recurring_root_causes</code> &mdash; repeated causes across incidents'],
      ['Has this happened before?',
       '<code>similar_past_rcas</code> &mdash; matched against completed RCAs on comparable endpoints'],
      ['Who owns the backlog?', 'Open RCAs grouped by owner and by team'],
      ['Is the backlog ageing?',
       '<code>age_days</code> per RCA, and the <code>rca_reminder_days</code> setting (default 7) ' +
       'which highlights anything older']
    ]),

    DOCS.callout('note', 'A reminder is not a chase',
      '<p><code>rca_reminder_days</code> only surfaces a backlog. Nothing escalates, nothing is ' +
      'blocked, and no notification is sent for an ageing RCA. <code>rca_default_due_days</code> ' +
      'defaults to <strong>0</strong>, meaning a requested RCA gets no deadline unless one is asked ' +
      'for.</p>'),

    `<h2>Turning the module off</h2>
    <p>The <code>feature_rca_enabled</code> setting hides the module in the UI <em>and</em> makes its
    API routes answer <strong>403</strong> &mdash; a disabled module must not stay reachable by
    anyone who knows the URL, or &ldquo;off&rdquo; is decoration. The response is 403 rather than 404
    because the route exists and the caller&rsquo;s permissions are fine; an administrator turned the
    module off, and saying so is what makes the response actionable.</p>

    <p>Existing incident history is unaffected. Note that the RCA router also carries the
    <code>/api/intelligence/*</code> routes the dashboard needs, so those are gated individually
    rather than by the whole router.</p>`

  ].join('\n')
});
