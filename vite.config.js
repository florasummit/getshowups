import { writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer, defineConfig } from 'vite'

// The privacy policy is also plain HTML (dist/privacy.html → /privacy), so it can be read without JavaScript. The page
// script then draws the same component.
function legalPages() {
  let out
  return {
    name: 'legal-pages',
    apply: 'build',
    configResolved: (c) => {
      out = resolve(c.root, c.build.outDir)
    },
    async closeBundle() {
      const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } })
      try {
        const { renderPrivacy } = await server.ssrLoadModule('/src/legal/render.jsx')
        const html = readFileSync(resolve(out, 'index.html'), 'utf8')
          .replace(/<title>[^]*?<\/title>/, '<title>Privacy Policy | GetShowUps</title>')
          .replace(/(<meta\s+name="description"\s+content=")[^"]*/, '$1How GetShowUps collects, uses, protects and deletes information, including Google user data.')
          .replace(/<noscript>[^]*?<\/noscript>/, '')
          .replace('<div id="root"></div>', () => `<div id="root">${renderPrivacy()}</div>`)
        writeFileSync(resolve(out, 'privacy.html'), html)
      } finally {
        await server.close()
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), legalPages()],
})
