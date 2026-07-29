import { defineConfig } from 'vite'

export default defineConfig({
  // Relative, so the same build works at a domain root and under a project
  // path like /AbuseJs/ on GitHub Pages. Every asset fetch in the app is
  // already relative to the document, so nothing else needs to know.
  base: './',
  server: { port: 5173 },
  build: { target: 'es2022' },
})
