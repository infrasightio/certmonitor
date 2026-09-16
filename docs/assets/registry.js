/**
 * Page registry and the small set of HTML helpers every content file uses.
 *
 * Loaded before any content file. Content files call DOCS.page({...}) to
 * register themselves; content/nav.js declares the sidebar order. There is no
 * build step and no module system on purpose - the site has to open from a
 * file:// path as readily as from nginx.
 */
window.DOCS = (function () {
  var pages = {};
  var ids = [];

  function page(def) {
    if (!def || !def.id) throw new Error('DOCS.page requires an id');
    pages[def.id] = def;
    ids.push(def.id);
  }

  /* ----------------------------------------------------------- helpers */

  /** Escape text that is about to be interpolated into HTML. */
  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** A fenced code block with an optional filename/label header. */
  function code(source, label) {
    var head = label ? '<div class="code-head"><span>' + esc(label) + '</span></div>' : '';
    return '<div class="code-block">' + head + '<pre><code>' + esc(source.replace(/^\n/, '').replace(/\s+$/, '')) + '</code></pre></div>';
  }

  /** An ASCII diagram with a caption. Monospace, never wrapped. */
  function diagram(art, caption) {
    return '<figure class="figure"><pre class="diagram">' + esc(art.replace(/^\n/, '').replace(/\s+$/, '')) +
      '</pre>' + (caption ? '<figcaption>' + esc(caption) + '</figcaption>' : '') + '</figure>';
  }

  /**
   * A table. `head` is an array of column labels, `rows` an array of arrays
   * whose cells are raw HTML (so they may contain <code>).
   */
  function table(head, rows) {
    var out = '<div class="table-wrap"><table><thead><tr>';
    head.forEach(function (h) { out += '<th>' + h + '</th>'; });
    out += '</tr></thead><tbody>';
    rows.forEach(function (row) {
      out += '<tr>';
      row.forEach(function (cell) { out += '<td>' + (cell == null ? '' : cell) + '</td>'; });
      out += '</tr>';
    });
    return out + '</tbody></table></div>';
  }

  /** kind: note | tip | warn | danger */
  function callout(kind, title, html) {
    return '<div class="callout ' + kind + '"><p class="callout-title">' + esc(title) + '</p>' + html + '</div>';
  }

  /** Cards: [{href, kicker, title, body}] */
  function cards(items) {
    var out = '<div class="cards">';
    items.forEach(function (item) {
      var tag = item.href ? 'a' : 'div';
      var href = item.href ? ' href="' + item.href + '"' : '';
      out += '<' + tag + ' class="card"' + href + '>' +
        (item.kicker ? '<span class="card-kicker">' + esc(item.kicker) + '</span>' : '') +
        '<h4>' + esc(item.title) + '</h4><p>' + item.body + '</p></' + tag + '>';
    });
    return out + '</div>';
  }

  /** Stat strip: [{value, label}] */
  function stats(items) {
    var out = '<div class="stats">';
    items.forEach(function (item) {
      out += '<div class="stat"><b>' + esc(item.value) + '</b><span>' + esc(item.label) + '</span></div>';
    });
    return out + '</div>';
  }

  /** Tabs: [{label, html}] - the first is selected. */
  var tabSeq = 0;
  function tabs(items) {
    var group = 'tabs-' + (++tabSeq);
    var bar = '<div class="tab-bar" role="tablist">';
    var panels = '';
    items.forEach(function (item, index) {
      var id = group + '-' + index;
      bar += '<button class="tab-btn" role="tab" type="button" id="' + id + '-tab"' +
        ' aria-controls="' + id + '" aria-selected="' + (index === 0) + '">' + esc(item.label) + '</button>';
      panels += '<div class="tab-panel" role="tabpanel" id="' + id + '" aria-labelledby="' + id + '-tab"' +
        (index === 0 ? '' : ' hidden') + '>' + item.html + '</div>';
    });
    return '<div class="tabs" data-tabs>' + bar + '</div>' + panels + '</div>';
  }

  /** A collapsed section. */
  function details(summary, html) {
    return '<details class="disclosure"><summary>' + esc(summary) + '</summary>' + html + '</details>';
  }

  /**
   * One API endpoint.
   * opts: {method, path, summary, auth, permission, body}
   */
  function endpoint(opts) {
    var access = opts.auth === false
      ? '<span class="badge open">no auth</span>'
      : '<span class="badge auth">bearer</span>';
    var perm = opts.permission
      ? '<span class="badge perm">' + esc(opts.permission) + '</span>'
      : '';
    return '<details class="endpoint"><summary>' +
      '<span class="method ' + opts.method.toLowerCase() + '">' + esc(opts.method) + '</span>' +
      '<span class="ep-path">' + esc(opts.path) + '</span>' + access + perm +
      (opts.summary ? '<span class="ep-note">' + esc(opts.summary) + '</span>' : '') +
      '</summary><div class="ep-body">' + (opts.body || '') + '</div></details>';
  }

  return {
    pages: pages,
    ids: ids,
    nav: [],
    page: page,
    esc: esc,
    code: code,
    diagram: diagram,
    table: table,
    callout: callout,
    cards: cards,
    stats: stats,
    tabs: tabs,
    details: details,
    endpoint: endpoint
  };
})();
