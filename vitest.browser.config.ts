import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const config: ReturnType<typeof defineConfig> = defineConfig({
  test: {
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: 'chromium' }],
      provider: playwright(),
    },
    include: ['test/browser/**/*.browser.ts'],
  },
})

export default config
