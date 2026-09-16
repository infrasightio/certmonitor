# InfraSight engineering documentation

The documentation site for this repository. Everything in it is derived from the
application source — `backend/app`, `frontend/src`, `docker-compose.yml` and
`.env.example` — rather than from a specification.

## Running it

There is no build step and no dependencies.

```bash
cd docs
python -m http.server 4173     # then open http://localhost:4173
```

Opening `docs/index.html` straight from the filesystem also works: routing is
hash-based (`#/monitoring`) precisely so the site needs no server rewrites.

## Layout

```
docs/
  index.html          the shell, and the list of content scripts
  assets/
    styles.css        every style; tokens on :root, dark mode redefines tokens
    registry.js       DOCS.page() and the HTML helpers
    app.js            hash router, sidebar, search, TOC, theme, copy, tabs
  content/
    nav.js            sidebar structure — also the prev/next order and the
                      breadcrumb group
    <id>.js           one file per page
```

## Adding a page

1. Write `content/<id>.js` calling `DOCS.page({ id, title, description, body })`.
2. Add a `<script src="content/<id>.js">` tag to `index.html`.
3. List the id under a group in `content/nav.js`.

`h2` and `h3` headings are picked up automatically — they get ids, anchor links,
a table-of-contents entry and their own search-index entry.

Helpers available on `DOCS`: `code`, `diagram`, `table`, `callout`, `cards`,
`stats`, `tabs`, `details`, `endpoint`, `esc`.

**One gotcha:** page bodies are JavaScript template literals, so a literal `$`
followed by `{` is interpolation. Escape it as `\${` when quoting a shell or
Compose snippet that uses one. `$VAR` and `$(...)` are fine as they are.

## Keeping it true

The two authoritative cross-checks are `/api/openapi.json`, generated from the
route definitions, and `GET /api/settings`, which returns every setting with its
live value, type and bounds. The "Maintaining and extending" page lists which
documentation page to update for each kind of code change.
