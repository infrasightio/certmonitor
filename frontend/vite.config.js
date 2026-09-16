import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = path.dirname(fileURLToPath(import.meta.url))
const DOCS_ROOT = path.resolve(here, '..', 'docs')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * Serve ../docs at /docs during development.
 *
 * In production the frontend image copies the documentation site into
 * nginx's web root and serves it there, so the "Documentation" link in the
 * app is a plain same-origin URL. The dev server has no such copy, and a
 * developer clicking that link would get a 404 - the one place the two
 * environments would disagree about what exists.
 *
 * Dev only: it lives in `configureServer`, so nothing here reaches the build.
 */
function docsDevServer() {
  return {
    name: 'infrasight-docs-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/docs', (req, res, next) => {
        const requested = decodeURIComponent((req.url || '/').split('?')[0])

        // Resolve first, then confirm the result is still inside docs/. A
        // path check before resolution would miss `..` segments and encoded
        // separators.
        const resolved = path.resolve(DOCS_ROOT, '.' + requested)
        if (resolved !== DOCS_ROOT && !resolved.startsWith(DOCS_ROOT + path.sep)) {
          res.statusCode = 403
          res.end('Forbidden')
          return
        }

        let file = resolved
        try {
          if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
        } catch {
          // Missing path: fall back to the docs shell, which routes on the
          // hash, exactly as the nginx location does.
          file = path.join(DOCS_ROOT, 'index.html')
        }

        fs.readFile(file, (error, body) => {
          if (error) return next()
          res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(body)
        })
      })
    },
  }
}

// The dev server proxies /api to the backend so the browser sees a single
// origin - the same topology nginx provides in production. That keeps cookies,
// CORS and relative URLs behaving identically in both environments.
export default defineConfig({
  plugins: [react(), docsDevServer()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8000',
        changeOrigin: true,
      },
      '/health': { target: process.env.VITE_API_TARGET || 'http://localhost:8000' },
      '/ready': { target: process.env.VITE_API_TARGET || 'http://localhost:8000' },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Charts are heavy and only needed on two screens; splitting them
        // keeps the initial bundle small.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
})
