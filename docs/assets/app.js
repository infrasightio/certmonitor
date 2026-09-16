/**
 * Documentation shell: hash router, sidebar, search, table of contents,
 * theme toggle, copy buttons and tabs.
 *
 * Hash routing (#/monitoring) rather than history routing so the site works
 * unchanged from a file:// path, from `python -m http.server`, and from any
 * static host with no rewrite rules.
 */
(function () {
  'use strict';

  var DOCS = window.DOCS;
  var THEME_KEY = 'infrasight-docs.theme';

  var el = {
    sidebar: document.getElementById('sidebar'),
    sidebarNav: document.getElementById('sidebarNav'),
    navToggle: document.getElementById('navToggle'),
    scrim: document.getElementById('scrim'),
    article: document.getElementById('article'),
    breadcrumbs: document.getElementById('breadcrumbs'),
    pager: document.getElementById('pager'),
    tocList: document.getElementById('tocList'),
    main: document.getElementById('doc-main'),
    searchInput: document.getElementById('searchInput'),
    searchResults: document.getElementById('searchResults'),
    themeToggle: document.getElementById('themeToggle')
  };

  /* ------------------------------------------------------------- order */

  // Flat, ordered list of page ids taken from the sidebar declaration, so
  // "previous / next" always matches what the reader sees on the left.
  var order = [];
  var groupOf = {};
  DOCS.nav.forEach(function (group) {
    group.items.forEach(function (id) {
      if (DOCS.pages[id]) {
        order.push(id);
        groupOf[id] = group.title;
      }
    });
  });

  var HOME = order[0] || 'home';

  /**
   * The short label for a page in the sidebar, the breadcrumb and the pager.
   * A page may set `navTitle` when its heading and its list entry want to read
   * differently - the landing page is headed "InfraSight" but lists as
   * "Overview".
   */
  function navTitle(id) {
    var page = DOCS.pages[id];
    return page.navTitle || page.title;
  }

  /* ------------------------------------------------------------- theme */

  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function currentlyDark() {
    var explicit = document.documentElement.getAttribute('data-theme');
    if (explicit) return explicit === 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  applyTheme(storedTheme());

  el.themeToggle.addEventListener('click', function () {
    var next = currentlyDark() ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }
  });

  /* ----------------------------------------------------------- sidebar */

  function renderSidebar() {
    var html = '';
    DOCS.nav.forEach(function (group) {
      var items = group.items.filter(function (id) { return DOCS.pages[id]; });
      if (!items.length) return;
      html += '<div class="nav-group"><p>' + DOCS.esc(group.title) + '</p><ul>';
      items.forEach(function (id) {
        html += '<li><a class="nav-link" data-page="' + id + '" href="#/' + id + '">' +
          DOCS.esc(navTitle(id)) + '</a></li>';
      });
      html += '</ul></div>';
    });
    el.sidebarNav.innerHTML = html;
  }

  function closeSidebar() {
    el.sidebar.classList.remove('is-open');
    el.scrim.hidden = true;
    el.navToggle.setAttribute('aria-expanded', 'false');
  }

  el.navToggle.addEventListener('click', function () {
    var open = el.sidebar.classList.toggle('is-open');
    el.scrim.hidden = !open;
    el.navToggle.setAttribute('aria-expanded', String(open));
  });
  el.scrim.addEventListener('click', closeSidebar);

  /* ------------------------------------------------------------ router */

  var currentId = null;

  /** The part of the hash after "#", without the leading slash. */
  function rawHash() {
    return (location.hash || '').replace(/^#/, '');
  }

  /**
   * A hash that does not start with "/" is a plain in-page anchor
   * (#some-heading), not a route. Those must not be resolved as a page id, or
   * clicking a table-of-contents entry would navigate to the home page.
   */
  function isInPageAnchor() {
    var raw = rawHash();
    return raw !== '' && raw.charAt(0) !== '/';
  }

  function routeId() {
    var raw = rawHash().replace(/^\//, '');
    var id = raw.split('#')[0].split('?')[0];
    return DOCS.pages[id] ? id : HOME;
  }

  function slugify(text) {
    return String(text).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function decorateHeadings(id) {
    var used = {};
    var headings = el.article.querySelectorAll('h2, h3');
    Array.prototype.forEach.call(headings, function (heading) {
      var base = heading.id || slugify(heading.textContent);
      var slug = base;
      var n = 2;
      while (used[slug]) { slug = base + '-' + (n++); }
      used[slug] = true;
      heading.id = slug;

      var anchor = document.createElement('a');
      anchor.className = 'anchor';
      anchor.href = '#/' + id + '#' + slug;
      anchor.setAttribute('aria-label', 'Link to this section');
      anchor.textContent = '#';
      heading.appendChild(anchor);
    });
    return headings;
  }

  function renderToc(id, headings) {
    if (!headings.length) {
      el.tocList.innerHTML = '';
      return;
    }
    var html = '';
    Array.prototype.forEach.call(headings, function (heading) {
      var text = heading.textContent.replace(/#$/, '').trim();
      var cls = heading.tagName === 'H3' ? ' class="toc-h3"' : '';
      // The full "#/page#anchor" form, so the route survives a click and a
      // subsequent reload lands on the same section.
      html += '<li><a' + cls + ' href="#/' + id + '#' + heading.id +
        '" data-toc="' + heading.id + '">' + DOCS.esc(text) + '</a></li>';
    });
    el.tocList.innerHTML = html;
  }

  function renderBreadcrumbs(id) {
    var parts = ['<a href="#/' + HOME + '">Docs</a>'];
    if (groupOf[id]) parts.push('<span class="current">' + DOCS.esc(groupOf[id]) + '</span>');
    parts.push('<span class="current">' + DOCS.esc(navTitle(id)) + '</span>');
    el.breadcrumbs.innerHTML = parts.join('<span class="sep">/</span>');
  }

  function renderPager(id) {
    var index = order.indexOf(id);
    var prev = index > 0 ? DOCS.pages[order[index - 1]] : null;
    var next = index > -1 && index < order.length - 1 ? DOCS.pages[order[index + 1]] : null;
    var html = '';
    if (prev) {
      html += '<a class="prev" href="#/' + order[index - 1] + '">' +
        '<span class="pager-dir">Previous</span><span class="pager-title">' +
        DOCS.esc(navTitle(order[index - 1])) + '</span></a>';
    }
    if (next) {
      html += '<a class="next" href="#/' + order[index + 1] + '">' +
        '<span class="pager-dir">Next</span><span class="pager-title">' +
        DOCS.esc(navTitle(order[index + 1])) + '</span></a>';
    }
    el.pager.innerHTML = html;
  }

  function addCopyButtons() {
    var blocks = el.article.querySelectorAll('.code-block');
    Array.prototype.forEach.call(blocks, function (block) {
      var pre = block.querySelector('pre');
      if (!pre) return;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-btn';
      button.textContent = 'Copy';
      button.addEventListener('click', function () {
        var text = pre.textContent;
        var done = function () {
          button.textContent = 'Copied';
          button.classList.add('is-done');
          setTimeout(function () {
            button.textContent = 'Copy';
            button.classList.remove('is-done');
          }, 1400);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
        } else {
          fallbackCopy(text, done);
        }
      });
      block.appendChild(button);
    });
  }

  function fallbackCopy(text, done) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* nothing to do */ }
    document.body.removeChild(area);
  }

  function wireTabs() {
    var groups = el.article.querySelectorAll('[data-tabs]');
    Array.prototype.forEach.call(groups, function (bar) {
      var buttons = bar.querySelectorAll('.tab-btn');
      Array.prototype.forEach.call(buttons, function (button) {
        button.addEventListener('click', function () {
          Array.prototype.forEach.call(buttons, function (other) {
            other.setAttribute('aria-selected', 'false');
            var panel = document.getElementById(other.getAttribute('aria-controls'));
            if (panel) panel.hidden = true;
          });
          button.setAttribute('aria-selected', 'true');
          var active = document.getElementById(button.getAttribute('aria-controls'));
          if (active) active.hidden = false;
        });
      });
    });
  }

  var tocObserver = null;

  function observeHeadings(headings) {
    if (tocObserver) tocObserver.disconnect();
    if (!window.IntersectionObserver || !headings.length) return;

    var links = {};
    Array.prototype.forEach.call(el.tocList.querySelectorAll('a[data-toc]'), function (link) {
      links[link.getAttribute('data-toc')] = link;
    });

    var visible = {};
    tocObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { visible[entry.target.id] = entry.isIntersecting; });
      var current = null;
      Array.prototype.forEach.call(headings, function (heading) {
        if (!current && visible[heading.id]) current = heading.id;
      });
      Object.keys(links).forEach(function (key) {
        links[key].classList.toggle('is-current', key === current);
      });
    }, { rootMargin: '-72px 0px -70% 0px', threshold: 0 });

    Array.prototype.forEach.call(headings, function (heading) { tocObserver.observe(heading); });
  }

  function render() {
    // A bare "#anchor" means "scroll within the page already shown". Re-rendering
    // would reset the article and lose the target.
    if (isInPageAnchor() && currentId) {
      var anchor = document.getElementById(rawHash());
      if (anchor) anchor.scrollIntoView();
      return;
    }

    var id = routeId();
    var fragment = rawHash().replace(/^\//, '').split('#')[1];

    // Same page, different section: scroll rather than rebuild. Rebuilding
    // would work, but it throws away scroll position and any open disclosure.
    if (id === currentId) {
      var section = fragment ? document.getElementById(fragment) : null;
      if (section) section.scrollIntoView();
      else window.scrollTo(0, 0);
      closeSidebar();
      return;
    }

    var page = DOCS.pages[id];
    currentId = id;

    document.title = (id === HOME ? 'InfraSight Engineering Docs' : page.title + ' - InfraSight Docs');
    el.article.innerHTML =
      '<h1>' + DOCS.esc(page.title) + '</h1>' +
      (page.description ? '<p class="lede">' + DOCS.esc(page.description) + '</p>' : '') +
      page.body;

    renderBreadcrumbs(id);
    var headings = decorateHeadings(id);
    renderToc(id, headings);
    observeHeadings(headings);
    renderPager(id);
    addCopyButtons();
    wireTabs();

    Array.prototype.forEach.call(el.sidebarNav.querySelectorAll('.nav-link'), function (link) {
      link.classList.toggle('is-current', link.getAttribute('data-page') === id);
    });

    closeSidebar();

    // "#/page#section" scrolls to the section; a plain page load goes to the top.
    if (fragment) {
      var target = document.getElementById(fragment);
      if (target) { target.scrollIntoView(); return; }
    }
    window.scrollTo(0, 0);
    el.main.focus({ preventScroll: true });
  }

  window.addEventListener('hashchange', render);

  /* ------------------------------------------------------------ search */

  // Built once from the rendered text of every page, so a search hit points at
  // the nearest heading rather than only at the page.
  var index = [];

  function buildIndex() {
    var scratch = document.createElement('div');
    order.forEach(function (id) {
      var page = DOCS.pages[id];
      scratch.innerHTML = page.body;

      index.push({
        id: id,
        anchor: '',
        title: page.title,
        crumb: groupOf[id] || 'Documentation',
        text: (page.description || '') + ' ' + scratch.textContent.slice(0, 400),
        weight: 3
      });

      var headings = scratch.querySelectorAll('h2, h3');
      Array.prototype.forEach.call(headings, function (heading) {
        var slug = slugify(heading.textContent);
        var text = '';
        var node = heading.nextElementSibling;
        while (node && node.tagName !== 'H2' && node.tagName !== 'H3') {
          text += ' ' + node.textContent;
          node = node.nextElementSibling;
        }
        index.push({
          id: id,
          anchor: slug,
          title: heading.textContent,
          crumb: page.title,
          text: text.slice(0, 600),
          weight: heading.tagName === 'H2' ? 2 : 1
        });
      });
    });
  }

  function score(entry, terms) {
    var title = entry.title.toLowerCase();
    var text = entry.text.toLowerCase();
    var total = 0;
    for (var i = 0; i < terms.length; i++) {
      var term = terms[i];
      var inTitle = title.indexOf(term);
      var inText = text.indexOf(term);
      if (inTitle === -1 && inText === -1) return 0;
      if (inTitle === 0) total += 12;
      else if (inTitle > -1) total += 8;
      if (inText > -1) total += 2;
    }
    return total + entry.weight;
  }

  function snippet(entry, term) {
    var text = entry.text.replace(/\s+/g, ' ').trim();
    var at = text.toLowerCase().indexOf(term);
    if (at < 0) return text.slice(0, 120);
    var from = Math.max(0, at - 40);
    return (from > 0 ? '...' : '') + text.slice(from, from + 140);
  }

  var activeHit = -1;

  function runSearch() {
    var query = el.searchInput.value.trim().toLowerCase();
    activeHit = -1;
    if (query.length < 2) {
      el.searchResults.hidden = true;
      el.searchInput.setAttribute('aria-expanded', 'false');
      return;
    }
    var terms = query.split(/\s+/);
    var hits = [];
    index.forEach(function (entry) {
      var value = score(entry, terms);
      if (value > 0) hits.push({ entry: entry, value: value });
    });
    hits.sort(function (a, b) { return b.value - a.value; });
    hits = hits.slice(0, 12);

    if (!hits.length) {
      el.searchResults.innerHTML = '<p class="search-empty">No matches for &ldquo;' +
        DOCS.esc(el.searchInput.value.trim()) + '&rdquo;</p>';
    } else {
      el.searchResults.innerHTML = hits.map(function (hit) {
        var entry = hit.entry;
        var href = '#/' + entry.id + (entry.anchor ? '#' + entry.anchor : '');
        return '<a class="search-hit" href="' + href + '" role="option">' +
          '<span class="hit-crumb">' + DOCS.esc(entry.crumb) + '</span>' +
          '<span class="hit-title">' + DOCS.esc(entry.title) + '</span>' +
          '<span class="hit-snippet">' + DOCS.esc(snippet(entry, terms[0])) + '</span></a>';
      }).join('');
    }
    el.searchResults.hidden = false;
    el.searchInput.setAttribute('aria-expanded', 'true');
  }

  function closeSearch() {
    el.searchResults.hidden = true;
    el.searchInput.setAttribute('aria-expanded', 'false');
    activeHit = -1;
  }

  el.searchInput.addEventListener('input', runSearch);
  el.searchInput.addEventListener('focus', function () {
    if (el.searchInput.value.trim().length >= 2) runSearch();
  });

  el.searchInput.addEventListener('keydown', function (event) {
    var hits = el.searchResults.querySelectorAll('.search-hit');
    if (event.key === 'Escape') { closeSearch(); el.searchInput.blur(); return; }
    if (!hits.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      activeHit += (event.key === 'ArrowDown' ? 1 : -1);
      if (activeHit < 0) activeHit = hits.length - 1;
      if (activeHit >= hits.length) activeHit = 0;
      Array.prototype.forEach.call(hits, function (hit, i) {
        hit.classList.toggle('is-active', i === activeHit);
      });
      hits[activeHit].scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter' && activeHit > -1) {
      event.preventDefault();
      location.hash = hits[activeHit].getAttribute('href');
      el.searchInput.blur();
      closeSearch();
    }
  });

  el.searchResults.addEventListener('click', function (event) {
    if (event.target.closest('.search-hit')) { closeSearch(); el.searchInput.blur(); }
  });

  document.addEventListener('click', function (event) {
    if (!event.target.closest('.search')) closeSearch();
  });

  document.addEventListener('keydown', function (event) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      el.searchInput.focus();
      el.searchInput.select();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      el.searchInput.focus();
      el.searchInput.select();
    }
  });

  /* -------------------------------------------------------------- boot */

  renderSidebar();
  buildIndex();
  render();
})();
