DOCS.page({
  id: 'diagnose',
  title: 'Diagnose',
  description: 'The layered triage engine: what it probes, what evidence it combines, how it ranks causes, and the limits it states rather than hides.',
  body: [

    `<h2>The question it answers</h2>
    <p>Not &ldquo;is this endpoint down&rdquo; &mdash; the dashboard already says that. Diagnose
    answers the question an operator actually has when something goes red: <em>which layer is broken,
    and what do I look at next?</em></p>

    <p>A request to an HTTPS endpoint passes through four stages, each of which can fail
    independently. Probing them separately localises the fault immediately: &ldquo;TLS handshake
    fine, HTTP 503&rdquo; is a completely different problem from &ldquo;TCP refused&rdquo;, even
    though both surface as DOWN in the dashboard.</p>`,

    DOCS.diagram(`
   DNS  ------>  TCP  ------>  TLS  ------>  HTTP
    |             |             |             |
    |             |             |             +-- status, latency, headers,
    |             |             |                 redirect chain, body size
    |             |             +-- handshake, certificate, chain, hostname
    |             |                 match, protocol and cipher
    |             +-- one connection PER RESOLVED ADDRESS, up to 4
    |                 (a load balancer with one dead backend shows up
    |                  here and nowhere else)
    +-- every address the name resolves to, IPv4 and IPv6 separately

   A stage is reported as ok / warning / failed / skipped, and a lower
   failure skips everything above it: "a lower layer failed - fix that first".
`, 'Probes run with an 8-second timeout each, because an operator is waiting on the response.'),

    `<h2>Three sources of evidence</h2>`,

    DOCS.table(['Source', 'What it contributes'], [
      ['<strong>Live probes</strong>',
       'The four stages above, run now. Per-address TCP is what makes a single bad backend visible.'],
      ['<strong>Stored history</strong>',
       'The distribution of failure reasons and status codes over the last 24 hours (up to 200 ' +
       'samples), whether the endpoint has <em>ever</em> succeeded, when it last did, a recent-checks ' +
       'availability strip, and the latency baseline.'],
      ['<strong>Correlation</strong>',
       'Whether sibling endpoints on the same host or in the same environment are also failing; ' +
       'whether the whole application is down; whether a declared dependency is down; whether a ' +
       'deployment finished shortly before the failure began; whether this has happened before.']
    ]),

    DOCS.callout('tip', 'Diagnosing never distorts the data',
      '<p>Everything here is read-only apart from the outbound probes. Nothing is written to ' +
      '<code>monitoring_results</code>, so running Diagnose on an endpoint cannot move its uptime ' +
      'figures. The <em>conclusion</em> is stored, in its own <code>diagnoses</code> table, so that ' +
      '&ldquo;has this happened before?&rdquo; can be answered next time.</p>'),

    `<h2>The full pass</h2>`,

    DOCS.diagram(`
  POST /api/endpoints/{id}/diagnose?focus=auto       needs endpoint:check
     |
     +-- load runtime settings and resolve this endpoint's thresholds
     |   (not module constants: an on-demand diagnosis must agree with the
     |    numbers Settings and ordinary monitoring actually use)
     |
     +-- LIVE
     |     _dns_stage        every address, IPv4 and IPv6 listed separately
     |     is_blocked_address on the first address -> note and skip TCP
     |     _tcp_stage        up to MAX_ADDRESSES (4) concurrent connections
     |     _tls_stage        only if TCP connected; skipped for http://
     |     _http_stage       only if the lower layers are ok
     |
     +-- STORED
     |     _history              24h window, 200 samples
     |     _correlation          same host / same environment siblings
     |     _failure_onset        when the current run of failures began
     |     _change_correlation   deployments inside the correlation window
     |     _incident_correlation the open incident, and its neighbours
     |     _recurrence           past diagnoses for this endpoint (30 days)
     |     _application_summary  blast radius across the application
     |     _dependency_correlation  declared dependencies that are also down
     |
     +-- REASON     _analyse(...)  ->  verdict, findings, actions, candidates
     |
     +-- STORE      a Diagnosis row: verdict, severity, confidence, headline,
     |              root cause, candidates, actions, and cross-links to the
     |              incident and change it correlated with
     v
  DiagnosticsResponse
`, 'The API client allows this call 90 seconds, against a 45-second default, because it runs several probes back to back.'),

    `<h2>Focus</h2>
    <p>The optional <code>focus</code> parameter says which question the operator is asking:
    <code>auto</code> (the default), <code>endpoint</code>, <code>ssl</code>,
    <code>availability</code>, <code>performance</code>, <code>recent_failure</code> or
    <code>deployment_impact</code>.</p>`,

    `<h2>How causes are ranked</h2>
    <p><strong>Rank causes, do not pick one.</strong> A 502 four minutes after a deployment has an
    obvious leading explanation and two plausible others; presenting only the leader hides the fact
    that it might be wrong. Every candidate carries the evidence that scored it, so a disagreeing
    engineer can see exactly which signal to challenge.</p>

    <p>Evidence is weighted in four bands, kept in one place so the model can be read at a glance:</p>`,

    DOCS.table(['Weight', 'Points', 'Means'], [
      ['<code>DIRECT</code>', '50',
       'A probe that observed the failure itself and admits few other readings &mdash; a refused TCP ' +
       'connection, an expired certificate'],
      ['<code>STRONG</code>', '30', 'A strong but not conclusive signal'],
      ['<code>SUPPORTING</code>', '15',
       'Real but weaker: a matching pattern in history, a sibling endpoint failing the same way'],
      ['<code>CIRCUMSTANTIAL</code>', '8',
       'Suggestive only &mdash; a deployment that finished nearby in time proves nothing on its own']
    ]),

    `<p>Candidates are sorted by accumulated score and each is expressed as a <strong>share of total
    evidence weight</strong>. That share is exactly that &mdash; a proportion of accumulated weight,
    labelled as such in the UI. It is not a probability, and pretending otherwise would put a decimal
    point on a handful of heuristics.</p>

    <h3>Confidence</h3>
    <p>Confidence comes from the evidence, not from tone. Two signals pointing the same way is Medium
    however confidently the sentence reads.</p>`,

    DOCS.table(['Band', 'Awarded when'], [
      ['<code>very_high</code>',
       'The leader scores at least 90, rests on at least 3 independent signals, and leads the ' +
       'runner-up by at least 40 points'],
      ['<code>high</code>', 'The leader rests on more than one signal and leads clearly'],
      ['<code>medium</code>', 'Supported, but not decisively'],
      ['<code>low</code>', 'Thin evidence'],
      ['<code>unknown</code>',
       'Nothing could be scored at all &mdash; a different and more honest statement than a ' +
       'low-confidence guess']
    ]),

    `<h2>Evidence honesty</h2>
    <p><strong>Never invent infrastructure.</strong> InfraSight observes an endpoint from the outside.
    It has no view of pods, containers, CPU or databases, and says so explicitly rather than producing
    a plausible guess. Every statement carries a <code>kind</code>:</p>`,

    DOCS.table(['Kind', 'Means'], [
      ['<code>observed</code>', 'Measured now, or read from the database'],
      ['<code>inferred</code>', 'A conclusion drawn from observations'],
      ['<code>unknown</code>',
       'Something that matters but is outside what InfraSight can see, so the operator knows to look ' +
       'themselves rather than assuming it was checked']
    ]),

    `<p>A <code>blind_spots</code> helper names what this vantage point cannot answer, and
    <code>verification_plan</code> says how to tell whether a fix worked &mdash; which is the part a
    diagnosis is usually missing.</p>`,

    `<h2>Recommended actions</h2>
    <p>Each action carries a title, detail, an optional command and its blast radius:</p>`,

    DOCS.table(['Risk', 'Means'], [
      ['<code>safe</code>', 'Read-only'],
      ['<code>disruptive</code>', 'Interrupts service briefly'],
      ['<code>high_risk</code>',
       'Can lose data or take an application down. <strong>Nothing in this band is ever executed by ' +
       'InfraSight</strong> &mdash; only described.']
    ]),

    DOCS.callout('warn', 'InfraSight executes nothing',
      '<p>Commands are suggestions rendered as text for a human to run. There is no remediation ' +
      'path, no SSH, no Kubernetes API client and no shell-out anywhere in the codebase. Where a ' +
      '<code>kubectl</code> or <code>docker</code> command would help it is offered, prefixed to make ' +
      'clear it is a suggestion rather than an observation about your platform.</p>'),

    `<h2>Severity</h2>
    <p>Wider than the alert severity scale on purpose: an alert only has to decide whether to wake
    someone, whereas a diagnosis has to rank a queue of endpoints an engineer is working through.
    The bands are <code>info</code>, <code>low</code>, <code>medium</code>, <code>high</code>,
    <code>critical</code>.</p>

    <p>Two factors weigh heavily in <code>severity_for</code>:</p>

    <ul>
      <li><strong>Production.</strong> The same 502 is a different problem on a staging host than on
      the one customers are using. &ldquo;Production&rdquo; means the endpoint&rsquo;s environment is
      listed in <code>fast_check_environments</code> &mdash; it is never guessed from a URL.</li>
      <li><strong>Blast radius.</strong> An application whose endpoints are all down is an outage,
      whereas one failing endpoint among many is a fault. A total outage of a production application
      is the top of the scale.</li>
    </ul>`,

    `<h2>Tunables</h2>
    <p>All runtime settings, so a diagnosis agrees with the rest of the application rather than
    carrying a second hardcoded copy of the same numbers.</p>`,

    DOCS.table(['Setting', 'Default', 'Used for'], [
      ['<code>latency_anomaly_multiplier</code>', '3.0',
       'How many times its own baseline an endpoint must slow down before that is a finding rather ' +
       'than normal variation'],
      ['<code>intermittent_availability_threshold_pct</code>', '95.0',
       'Below this on the recent-checks strip, an endpoint that passes now is reported as an ' +
       'intermittent failure &mdash; it is not reliably healthy'],
      ['<code>recovery_checks_required</code>', '3',
       'How many consecutive passing checks a diagnosis asks for before calling something resolved. ' +
       'One passing probe is not a recovery.'],
      ['<code>deployment_correlation_minutes</code>', '30',
       'A deployment finishing within this long before a failure begins is reported as correlated ' +
       '&mdash; always described as a correlation, never as a confirmed cause']
    ]),

    `<h2>Diagnosis history</h2>
    <p>A single diagnosis answers &ldquo;what is wrong right now&rdquo;. Keeping them lets the engine
    answer a harder and more useful question: <em>is this the fourth time this month?</em> A recurring
    502 every Monday morning is a capacity problem, not four unrelated outages, and only the history
    makes that visible.</p>

    <p>Only the conclusion is stored, never the raw probe payload &mdash; that data is large, loses
    relevance within minutes, and would grow the table without bound.</p>`,

    DOCS.table(['Route', 'Does'], [
      ['<code>GET /api/endpoints/{id}/diagnoses</code>',
       'Past diagnoses for this endpoint, newest first, paginated'],
      ['<code>POST /api/endpoints/{id}/diagnoses/{diagnosis_id}/resolution</code>',
       'Record what actually fixed it']
    ]),

    DOCS.callout('tip', 'The resolution field is the point',
      '<p><code>resolution</code>, <code>resolved_at</code> and <code>resolved_by</code> are filled ' +
      'in later by an operator. That is the field that turns a pile of diagnoses into institutional ' +
      'knowledge, and it is also what <code>similar_past_rcas</code> and the recurring-cause ' +
      'analytics read.</p>'),

    `<h2>Operational intelligence</h2>
    <p>Three related routes under <code>/api/intelligence</code>, all computed on the server from its
    own database. Nothing here calls anything outside this server.</p>`,

    DOCS.table(['Route', 'Returns'], [
      ['<code>GET /api/intelligence/summary</code>',
       'The Smart DevOps summary: what needs attention right now &mdash; unhealthy endpoints, ' +
       'deployment/incident correlations, performance anomalies, and a ranked attention list'],
      ['<code>GET /api/intelligence/daily?hours=</code>',
       'What happened over a period, and what it suggests'],
      ['<code>GET /api/intelligence/search?q=</code>',
       'Infrastructure search: turns a question like &ldquo;production services that are down&rdquo; ' +
       'into a database query']
    ]),

    DOCS.callout('note', 'The search parser is deliberately not a language model',
      '<p>It recognises a fixed vocabulary of intents and filters and refuses anything it does not ' +
      'understand. That buys three properties an LLM could not offer here: the query never leaves ' +
      'the server, the same question always returns the same rows, and a question it cannot parse ' +
      'produces an honest &ldquo;I did not understand that&rdquo; instead of a confident wrong ' +
      'answer.</p>')

  ].join('\n')
});
