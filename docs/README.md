# InfraSight engineering documentation

The documentation site for this repository. Everything in it is derived from the
application source — `backend/app`, `frontend/src`, `docker-compose.yml` and
`.env.example` — rather than from a specification.

## Where it is served

This site ships **inside the application**. The frontend image copies `docs/`
into nginx's web root, so a running InfraSight serves it at `/docs` on its own
origin, and the app's sidebar carries a **Documentation** link to it.

```
http://localhost:8080/docs/     a running stack
http://localhost:5173/docs/     the frontend dev server (see vite.config.js)
docs/index.html                 straight from the filesystem, no server needed
```

Hash routing (`#/monitoring`) is what makes that last one work — the site needs
no server rewrites anywhere.

## Constraints

Because it is served from inside the product, three rules are not optional:

- **No external requests.** The frontend enforces `default-src 'self'`, and
  these hosts are frequently air-gapped. No webfont, no CDN, no analytics.
- **No inline scripts.** `script-src 'self'` carries no `'unsafe-inline'`.
- **The frontend build context is the repository root**, so `docs/` is
  reachable. `.dockerignore` deliberately does not exclude it.

There is no build step and no dependencies.

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
4. Nothing for the container — `COPY docs` takes the whole directory.

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
