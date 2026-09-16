DOCS.page({
  id: 'ssl',
  title: 'TLS certificates',
  description: 'How certificates are observed, classified, kept as history, re-graded between checks and alerted on.',
  body: [

    `<h2>When a certificate is inspected</h2>
    <p>There are three paths into certificate data, and an HTTPS endpoint normally takes the first.</p>`,

    DOCS.diagram(`
  1. PIGGYBACK on the HTTP check                       (the usual case)
       the request completes, and the TLS details are pulled off the very
       socket that served it:
           network_stream.get_extra_info("ssl_object")
           -> leaf DER, chain DER, protocol version, cipher
       No second connection, no extra load on the monitored host.

  2. FALLBACK probe                                    (the request failed)
       needs_cert = http check AND protocol is https
                    AND ssl_monitoring_enabled
                    AND no certificate was captured above
       -> probe_tls(hostname, port, ...) opens its own connection
       So an expiring certificate on a currently-failing endpoint is still
       reported, instead of going dark exactly when it matters.

  3. TLS-ONLY check                                    (check_type = tls)
       probe_tls() is the whole check. No HTTP request is made.
`, 'ssl_monitoring_enabled on the endpoint, and protocol == https, gate all of this. For anything else the endpoint’s ssl_status is set to not_applicable.'),

    `<h2>What is recorded</h2>
    <p><code>describe_certificate</code> parses the leaf DER with <code>cryptography</code> and
    produces the row stored in <code>ssl_certificates</code>.</p>`,

    DOCS.table(['Field', 'Content'], [
      ['<code>fingerprint_sha256</code>',
       'Uppercase colon-separated SHA-256 of the DER. This is the identity: a change means a new ' +
       'certificate, and a new row.'],
      ['<code>serial_number</code>', 'Uppercase hexadecimal'],
      ['<code>subject</code>, <code>common_name</code>', 'Full RFC4514-style subject, and the CN alone'],
      ['<code>issuer</code>, <code>issuer_common_name</code>, <code>issuer_organization</code>',
       'Full issuer plus the two parts worth filtering and grouping on'],
      ['<code>san</code>', 'Subject Alternative Name entries, as a JSON list'],
      ['<code>valid_from</code>, <code>valid_to</code>, <code>days_remaining</code>',
       'Timezone-aware, and the whole-day count derived from <code>valid_to</code>'],
      ['<code>signature_algorithm</code>, <code>key_algorithm</code>, <code>key_size</code>, <code>version</code>',
       'Certificate properties'],
      ['<code>tls_version</code>, <code>tls_cipher</code>',
       'Of the connection that observed it, not of the certificate'],
      ['<code>is_self_signed</code>, <code>is_wildcard</code>', 'Derived flags'],
      ['<code>hostname_matches</code>',
       'Wildcard-aware match of the endpoint hostname against CN and SAN'],
      ['<code>chain_verified</code>, <code>verification_status</code>, <code>verification_error</code>',
       'Whether the chain verified. <code>true</code> when the handshake succeeded through a ' +
       'verifying context; <code>null</code> when <code>verify_ssl</code> is off, because nothing ' +
       'was checked.'],
      ['<code>chain</code>, <code>chain_length</code>', 'The presented intermediate chain'],
      ['<code>is_current</code>', 'Exactly one row per endpoint carries this'],
      ['<code>first_seen_at</code>, <code>checked_at</code>',
       'When this certificate was first observed, and when it was last confirmed']
    ]),

    `<h2>Classification</h2>
    <p>One function decides the state, and it is used by the live check, the fallback probe and the
    periodic re-grade &mdash; so the three can never disagree.</p>`,

    DOCS.code(`def classify_certificate(days_remaining, *, warning_days, critical_days,
                         is_valid=True, verification_failed=False):
    if days_remaining is None:          return "unable_to_check"
    if days_remaining < 0:              return "expired"
    if not is_valid or verification_failed:
        return "invalid"
    if days_remaining <= critical_days: return "critical"
    if days_remaining <= warning_days:  return "expiring_soon"
    return "valid"`, 'app/monitoring/ssl_inspect.py'),

    DOCS.table(['State', 'Meaning', 'Endpoint effect'], [
      ['<code>valid</code>', 'More than <code>warning_days</code> remaining and nothing wrong', 'None'],
      ['<code>expiring_soon</code>', 'Inside the warning window (default 30 days)',
       'Raises <code>ssl_expiring</code> (warning)'],
      ['<code>critical</code>', 'Inside the critical window (default 7 days)',
       'Raises <code>ssl_expiring</code> at critical severity'],
      ['<code>expired</code>', 'Past <code>notAfter</code>',
       'Raises <code>ssl_expired</code>. On a verifying HTTPS check this also forces the check itself ' +
       'to <code>down</code> with <code>cert_expired</code>, even if the server answered.'],
      ['<code>invalid</code>', 'Chain verification failed, or the hostname does not match',
       'Raises <code>ssl_invalid</code>'],
      ['<code>unable_to_check</code>', 'No certificate could be read at all',
       'Recorded on the endpoint so the SSL page can show a reason rather than a blank'],
      ['<code>not_applicable</code>', 'The endpoint is not HTTPS, or SSL monitoring is off for it',
       'Excluded from every certificate count']
    ]),

    DOCS.callout('note', 'Threshold resolution',
      '<p><code>ssl_warning_days</code> and <code>ssl_critical_days</code> resolve in the same order ' +
      'as every other threshold: <strong>endpoint override &rarr; environment override &rarr; ' +
      'runtime setting &rarr; built-in default</strong>. A cross-field check refuses a critical ' +
      'threshold above the warning threshold, at both the environment-variable layer and the ' +
      'settings layer, because that would leave the &ldquo;Warning&rdquo; band empty.</p>'),

    `<h2>Certificate history</h2>
    <p>The endpoint carries a denormalised summary for fast filtering; the full observation lives in
    <code>ssl_certificates</code>.</p>`,

    DOCS.diagram(`
  a check observes a certificate
     |
     +-- no fingerprint at all?
     |      -> write nothing; set endpoints.ssl_status to the failure state
     |
     +-- current row has the SAME fingerprint?
     |      -> refresh only the volatile fields:
     |         days_remaining, status, tls_version, tls_cipher,
     |         hostname_matches, chain_verified, verification_*,
     |         chain, chain_length, checked_at
     |
     +-- different fingerprint?
            -> old row: is_current = False        (it becomes history)
            -> log certificate_rotated with both fingerprints
            -> INSERT a new row, is_current = True, first_seen_at = now

  either way, the endpoint is updated with:
     ssl_status, ssl_expires_at, ssl_days_remaining,
     ssl_issuer, ssl_common_name
`, 'This is what makes GET /api/endpoints/{id}/ssl/history a renewal record rather than a single snapshot.'),

    `<h2>The SSL sweep</h2>
    <p>Certificates expire on the calendar, not on a check schedule. An endpoint on a one-hour
    interval could cross the warning threshold and stay silent until its next check, so the worker
    runs an independent sweep every hour.</p>`,

    DOCS.diagram(`
  every 3600s (SSL_SWEEP_INTERVAL_SECONDS, a module constant)
     |
     +-- load settings with use_cache=False   (this loop is slow; take the truth)
     |
     +-- regrade_certificates(warning_days, critical_days)
     |      for every is_current row with a valid_to:
     |         days = floor((valid_to - now) / 1 day)
     |         status = classify_certificate(days, ...)
     |         if either changed:
     |             update the ssl_certificates row
     |             UPDATE endpoints SET ssl_status, ssl_days_remaining,
     |                                  ssl_expires_at
     |      -> log certificates_regraded / ssl_sweep_completed
     |
     +-- if alerts_enabled:
            for every current certificate in expiring_soon / critical /
            expired / invalid, whose endpoint has ssl_monitoring_enabled
            and alerts_enabled:
                evaluate_ssl_alert(...)   - the same evaluation a live
                                            check uses, via an adapter that
                                            presents the stored row as a
                                            CertificateInfo
`, 'Without the re-grade, editing the SSL warning threshold would only take effect as each endpoint happened to be checked again. The alert cooldown is what stops this re-notifying hourly for the same certificate.'),

    `<h2>The certificate dashboard</h2>
    <p>Backed by three routes, all requiring <code>endpoint:read</code>.</p>`,

    DOCS.table(['Route', 'Returns'], [
      ['<code>GET /api/ssl/summary</code>',
       'Counts per state, plus expiry buckets for the timeline chart'],
      ['<code>GET /api/ssl</code>',
       'A paginated, filterable row per endpoint with its current certificate'],
      ['<code>GET /api/ssl/issuers</code>',
       'The distinct issuer common names present, for the issuer filter'],
      ['<code>GET /api/ssl/export</code>',
       'The whole <em>filtered</em> set as an Excel workbook &mdash; not just the page on screen. ' +
       'Requires <code>endpoint:export</code> and writes an ' +
       '<code>endpoints_exported</code> audit entry.']
    ]),

    `<p>Per-endpoint detail comes from <code>GET /api/endpoints/{id}/ssl</code> (the current
    certificate) and <code>GET /api/endpoints/{id}/ssl/history</code> (every observation, newest
    first).</p>`,

    DOCS.callout('warn', 'verify_ssl off means chain_verified is unknown, not true',
      '<p>Turning off <code>verify_ssl</code> for an endpoint with a self-signed or internal-CA ' +
      'certificate makes the check pass, and expiry tracking keeps working. But ' +
      '<code>chain_verified</code> is then recorded as <code>null</code> rather than ' +
      '<code>true</code>, because nothing was verified &mdash; and an expired certificate no longer ' +
      'forces the check down, since that hard failure is conditional on <code>verify_ssl</code>.</p>')

  ].join('\n')
});
