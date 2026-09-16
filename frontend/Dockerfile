# Frontend image: build the SPA, then serve it from nginx.
#
# nginx also reverse-proxies /api, /health and /ready to the backend, so the
# browser only ever talks to one origin. That removes CORS from the picture
# entirely and matches how the app is expected to sit behind an ingress.
#
# The build context is the REPOSITORY ROOT, not ./frontend, because this image
# also serves the documentation site at /docs. Shipping the docs inside the
# image rather than mounting them keeps a registry-based deploy - Kubernetes
# included - self-contained, and means the documentation is readable on an
# air-gapped host. Paths below are therefore root-relative.

# ---------------------------------------------------------------- builder
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually
# change.
COPY frontend/package.json frontend/package-lock.json* ./

# `npm ci` requires a lockfile; fall back to `npm install` so a fresh clone
# without one still builds.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY frontend/ .

RUN npm run build

# ---------------------------------------------------------------- runtime
FROM nginx:1.27-alpine AS runtime

LABEL org.opencontainers.image.title="InfraSight Frontend" \
      org.opencontainers.image.description="Dashboard for endpoint and SSL monitoring"

RUN apk add --no-cache curl

COPY --from=builder /app/dist /usr/share/nginx/html

# The documentation site, served at /docs. It is plain HTML, CSS and scripts
# with no build step and no external requests, so it is copied verbatim rather
# than compiled.
COPY docs /usr/share/nginx/html/docs

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/security-headers.conf /etc/nginx/snippets/security-headers.conf

# nginx:alpine ships an unprivileged `nginx` user, but the stock image needs
# to bind :80 and write its pid as root. Running the master as root and the
# workers as nginx is the image's own default and is the least surprising
# choice here.

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
