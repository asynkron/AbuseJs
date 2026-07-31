import { resolve } from 'node:path'

import { defineConfig } from 'vite'

export default defineConfig({
  // Relative, so the same build works at a domain root and under a project
  // path like /AbuseJs/ on GitHub Pages. Every asset fetch in the app is
  // already relative to the document, so nothing else needs to know.
  base: './',
  server: { port: 5173 },
  build: {
    target: 'es2022',
    // Two pages. Naming them is what stops Vite from treating viewer.html as a
    // stray file and leaving it out of the build - the game is index.html, and
    // viewer.html is the sprite viewer, which ships alongside it because it
    // reads the same atlas and is useful wherever the game is.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        viewer: resolve(__dirname, 'viewer.html'),
      },
    },
  },
})
