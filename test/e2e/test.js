// Shared Playwright `test`: blocks every non-local request so smoke tests never touch real
// Google or any other external service. Specs can still mock specific URLs with
// context.route()/page.route(); later-registered routes take precedence over this guard.
import { test as base, expect } from '@playwright/test'

const isLocal = (url) => url.hostname === '127.0.0.1' || url.hostname === 'localhost'

export const test = base.extend({
  context: async ({ context }, provide) => {
    await context.route((url) => !isLocal(url), (route) => route.abort('blockedbyclient'))
    await provide(context)
  },
})

export { expect }
