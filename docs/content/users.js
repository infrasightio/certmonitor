DOCS.page({
  id: 'users',
  title: 'Users and access control',
  description: 'Authentication, the three built-in roles and exactly what each may do, session invalidation, brute-force protection and the audit trail.',
  body: [

    `<h2>Authentication model</h2>
    <p>Stateless JWT bearer tokens, with one piece of server-side state that makes revocation
    possible.</p>`,

    DOCS.table(['Element', 'Detail'], [
      ['Password hashing', 'bcrypt at 12 rounds, via passlib. Only the digest is stored; the ' +
       'plaintext never leaves the request scope.'],
      ['Access token',
       'Default 60 minutes (<code>ACCESS_TOKEN_EXPIRE_MINUTES</code>, overridable at runtime by the ' +
       '<code>session_timeout_minutes</code> setting)'],
      ['Refresh token',
       'Default 7 days (<code>REFRESH_TOKEN_EXPIRE_DAYS</code> / <code>session_refresh_days</code>)'],
      ['Algorithm', 'HS256, signed with <code>JWT_SECRET</code>'],
      ['Claims',
       '<code>sub</code> (user id), <code>type</code> (<code>access</code> or <code>refresh</code>), ' +
       '<code>iat</code>, <code>exp</code>, <code>jti</code>, <code>tv</code> (token version), ' +
       '<code>role</code>. Decoding <em>requires</em> <code>exp</code>, <code>sub</code> and ' +
       '<code>type</code>.'],
      ['Transport', 'The SPA stores both tokens in <code>localStorage</code> and sends the access ' +
       'token as <code>Authorization: Bearer</code>.']
    ]),

    `<h3>Password policy</h3>
    <p><code>validate_password_strength</code> requires at least
    <code>PASSWORD_MIN_LENGTH</code> characters (default 10), at most 72 <em>bytes</em>, and at least
    one lowercase letter, one uppercase letter, one digit and one special character. Every problem is
    returned, not just the first.</p>`,

    DOCS.callout('note', 'Why 72 bytes',
      '<p>bcrypt has a hard 72-byte input limit. Rather than let passlib silently truncate a longer ' +
      'password &mdash; which would make two different passwords equivalent &mdash; validation ' +
      'rejects it. <code>GET /api/auth/password-policy</code> exposes the minimum length so the ' +
      'client can validate before submitting.</p>'),

    `<h2>Session invalidation</h2>
    <p>There is no server-side session store. <code>users.token_version</code> is the whole mechanism:
    the value is stamped into every token as <code>tv</code> and compared on every request.</p>`,

    DOCS.diagram(`
   users.token_version = 4
        |
        +-- tokens issued carry tv=4
        |
   something invalidates sessions:
        password changed by the user
        password reset by an administrator
        (any other write that bumps the counter)
        |
        v
   users.token_version = 5
        |
        +-- every token carrying tv=4 now fails with
            401 "Session is no longer valid. Please sign in again."
            - immediately, everywhere, without a revocation list
`, 'This is also the answer to "how do I force someone out right now": reset their password.'),

    `<h2>Roles and permissions</h2>
    <p>Three system roles, created and kept in step by <code>ensure_roles</code> on every boot. The
    process is idempotent and <em>additive</em>: a permission added to the enum in a later release is
    granted to its roles the next time the application starts, so an upgrade needs no migration for
    new permissions.</p>`,

    DOCS.table(['Permission', 'admin', 'approver', 'viewer'], [
      ['<code>endpoint:read</code>', 'yes', 'yes', 'yes'],
      ['<code>endpoint:export</code>', 'yes', 'yes', 'yes'],
      ['<code>endpoint:write</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>endpoint:delete</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>endpoint:check</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>endpoint:import</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>alert:read</code>', 'yes', 'yes', 'yes'],
      ['<code>alert:write</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>incident:read</code>', 'yes', 'yes', 'yes'],
      ['<code>incident:write</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>settings:read</code>', 'yes', 'yes', 'yes'],
      ['<code>settings:write</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>audit:read</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>user:read</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>user:write</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>user:delete</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>tag:write</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>environment:write</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>notification:write</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>change:read</code>', 'yes', 'yes', 'yes'],
      ['<code>change:write</code>', 'yes', 'yes', 'yes'],
      ['<code>change:comment</code>', 'yes', 'yes', 'yes'],
      ['<code>change:approve</code>', 'yes', 'yes', '&mdash;'],
      ['<code>change:deploy</code>', 'yes', '&mdash;', '&mdash;'],
      ['<code>change:cancel</code>', 'yes', '&mdash;', '&mdash;']
    ]),

    DOCS.table(['Role', 'In one line'], [
      ['<code>admin</code>', 'Every permission. Also the only role that may reopen an RCA, and the ' +
       'only one <code>require_admin()</code> accepts.'],
      ['<code>approver</code>',
       'Approves changes and sees the monitoring context needed to judge them, but cannot deploy or ' +
       'alter monitoring configuration.'],
      ['<code>viewer</code>',
       'Read-only across monitoring, <em>plus</em> the shared change conversation &mdash; raise, ' +
       'read and comment on changes &mdash; and export.']
    ]),

    DOCS.callout('note', 'Two permission paths bypass the role table',
      '<p><strong>RCA ownership.</strong> The assigned owner of an RCA &mdash; a matching user id, ' +
      'or anyone whose free-text team label matches &mdash; may edit and complete it regardless of ' +
      'role. That is what lets a viewer own an RCA, which is the whole point of assigning it to ' +
      'them.</p>' +
      '<p><strong>Finishing a deployment.</strong> Any <code>change:deploy</code> holder may start ' +
      'one, but finishing is restricted to the person who started it, or an administrator.</p>'),

    `<h3>Enforcement</h3>
    <p>Dependencies in <code>app/api/deps.py</code> compose in a fixed order. A denial is logged as
    <code>authorisation_denied</code> with the username, role and missing codes, and the client
    receives a generic &ldquo;Your role does not permit this action.&rdquo; rather than a list of what
    it lacks.</p>`,

    DOCS.diagram(`
  get_current_user       token valid, user exists, active, tv matches
        |
        v
  get_active_user        403 + X-Password-Change-Required if the password
        |                must be changed. This is why a forced change closes
        |                every route except the password ones.
        v
  require_permissions(*codes)      403 if ANY code is missing
        |
        v
  require_feature(setting_key)     403 if an administrator disabled the module
        |
        v
  handler
`, 'require_admin() is a separate, blunter gate used where a permission code would be too fine-grained.'),

    `<h2>Managing users</h2>`,

    DOCS.table(['Route', 'Permission', 'Notes'], [
      ['<code>GET /api/users</code>', '<code>user:read</code>',
       'Paginated; filter by search, role, <code>is_active</code>'],
      ['<code>GET /api/users/roles</code>', '<code>user:read</code>',
       'Each role with its permission codes &mdash; what the UI renders on the role picker'],
      ['<code>POST /api/users</code>', '<code>user:write</code>',
       'The password supplied is temporary: unless the caller opts out, the new user must replace it ' +
       'at first sign-in'],
      ['<code>PUT /api/users/{id}</code>', '<code>user:write</code>',
       'Details, role, active flag, team'],
      ['<code>POST /api/users/{id}/reset-password</code>', '<code>user:write</code>',
       'Bumps <code>token_version</code>, so every session that user holds is invalidated'],
      ['<code>POST /api/users/{id}/reset-lockout</code>', '<code>user:write</code>',
       'Clears <strong>both</strong> sign-in throttles'],
      ['<code>DELETE /api/users/{id}</code>', '<code>user:write</code>',
       'Audit entries survive: <code>audit_logs.username</code> is denormalised for exactly this ' +
       'reason']
    ]),

    DOCS.callout('tip', 'The last-admin invariant',
      '<p>The final <em>active</em> administrator cannot be demoted, disabled or deleted. An ' +
      'instance can therefore never be locked out of its own administration. Attempting it returns ' +
      '400 with the reason.</p>'),

    `<h2>Brute-force protection</h2>
    <p>Two independent throttles on the sign-in path, which trip at different points. Clearing one was
    never enough, which is why <code>reset-lockout</code> clears both.</p>`,

    DOCS.table(['Throttle', 'Scope', 'Controls', 'Response'], [
      ['<strong>Rate limit</strong>',
       'Per source address <em>and</em> per username, in a sliding window',
       '<code>LOGIN_RATE_LIMIT_ATTEMPTS</code> (5) in ' +
       '<code>LOGIN_RATE_LIMIT_WINDOW_SECONDS</code> (300)',
       '<strong>429</strong> with <code>Retry-After</code>, and a <code>login_failed</code> audit ' +
       'entry marked <code>rate_limited</code>'],
      ['<strong>Account lockout</strong>',
       'On the user row',
       '<code>account_lockout_attempts</code> (8) consecutive failures locks for ' +
       '<code>account_lockout_minutes</code> (15). Both are runtime settings.',
       '<strong>423 Locked</strong>, and a <code>login_failed</code> audit entry marked ' +
       '<code>locked</code>']
    ]),

    `<p>The rate limiter uses Redis when reachable so the limit holds across every API replica, and
    falls back to an in-process sliding window otherwise. <strong>The fallback is deliberately still
    enforced</strong>: a single-container deployment must not silently lose brute-force protection
    because Redis is absent. The in-process store prunes itself once it exceeds 10,000 keys.</p>`,

    DOCS.callout('warn', 'Accounts cannot be enumerated',
      '<p>An unknown username and a wrong password produce the <em>same</em> generic 401. On a miss, ' +
      '<code>authenticate</code> still verifies against a throwaway hash so response timing does not ' +
      'reveal whether the account exists. A successful sign-in clears the counters and ' +
      'opportunistically re-hashes if the bcrypt cost has since been raised.</p>'),

    `<h2>The audit trail</h2>
    <p>Every administrative mutation funnels through <code>audit_service.record</code>, so the trail
    is consistent and impossible to forget in a route handler.</p>`,

    DOCS.table(['Column', 'Content'], [
      ['<code>user_id</code>, <code>username</code>',
       'The id, plus a denormalised username so the trail survives user deletion'],
      ['<code>action</code>', 'One of the <code>AuditAction</code> values, indexed'],
      ['<code>resource_type</code>, <code>resource_id</code>, <code>resource_name</code>',
       'What was acted on'],
      ['<code>details</code>',
       'Scrubbed JSON. Typically a <code>{field: {from, to}}</code> change map.'],
      ['<code>status</code>', '<code>success</code>, <code>failure</code>, <code>locked</code>, ' +
       '<code>rate_limited</code>'],
      ['<code>ip_address</code>, <code>user_agent</code>, <code>request_method</code>, ' +
       '<code>request_path</code>', 'Request context. The address comes from ' +
       '<code>X-Forwarded-For</code>, which nginx sets.']
    ]),

    `<h3>What is recorded</h3>
    <p>Sign-in and sign-out, failed sign-ins, password changes and resets; user create, update,
    delete, enable, disable and role change; endpoint create, update, delete, check, import and
    export; settings changes; tag and environment lifecycle; notification-channel lifecycle; alert
    acknowledgement; incident update and comment; the full RCA lifecycle; and the full change and
    deployment lifecycle.</p>

    <h3>Redaction, in two places</h3>
    <ul>
      <li><strong>Audit details</strong> pass through <code>scrub</code>, which recursively replaces
      anything credential-shaped &mdash; <code>password</code>, <code>auth_secret</code>,
      <code>token</code>, <code>secret</code>, <code>api_key</code>, <code>config</code>,
      <code>webhook_url</code>, <code>smtp_password</code>, <code>routing_key</code> and their
      relatives &mdash; with <code>***redacted***</code>. It also truncates long strings, caps lists
      at 50 items and stops at depth 4.</li>
      <li><strong>Logs</strong> pass through a structlog processor with its own key list, covering
      the same fields plus <code>jwt_secret</code>, <code>encryption_key</code> and
      <code>database_url</code>.</li>
    </ul>

    <p><code>GET /api/audit-logs</code> requires <code>audit:read</code>, which only administrators
    hold. <code>GET /api/audit-logs/actions</code> returns the distinct actions present, for the
    filter. Entries older than <code>audit_retention_days</code> (default 365) are deleted by the
    retention sweep.</p>`,

    `<h2>Encryption at rest</h2>
    <p>Two kinds of secret are encrypted with Fernet (AES-128-CBC with HMAC), keyed from
    <code>ENCRYPTION_KEY</code> or, when that is unset, derived from <code>JWT_SECRET</code> by
    SHA-256:</p>

    <ul>
      <li><code>endpoints.auth_secret_encrypted</code> &mdash; the bearer token, basic-auth password
      or custom header value used to reach a monitored endpoint.</li>
      <li><code>notification_channels.config_encrypted</code> &mdash; the entire provider
      configuration as one blob, so no webhook URL, SMTP password or routing key is ever stored in
      the clear.</li>
    </ul>`,

    DOCS.callout('danger', 'Set ENCRYPTION_KEY explicitly if you might rotate JWT_SECRET',
      '<p>Leaving <code>ENCRYPTION_KEY</code> blank derives the encryption key from ' +
      '<code>JWT_SECRET</code>. Rotating <code>JWT_SECRET</code> then makes every stored credential ' +
      'undecryptable. <code>decrypt_secret</code> returns <code>None</code> rather than raising: the ' +
      'worker logs <code>endpoint_credential_undecryptable</code> and records the check as a ' +
      '<code>config_error</code> failure, and a notification channel reports &ldquo;channel ' +
      'configuration could not be decrypted &mdash; it must be re-entered after an encryption key ' +
      'change&rdquo;. Recovery means re-entering every affected credential.</p>')

  ].join('\n')
});
