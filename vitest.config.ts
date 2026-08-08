import { svelte } from "@sveltejs/vite-plugin-svelte"
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    svelte(),
  ],
  resolve: {
    alias: {
      src: '/src',
    },
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['vitest.setup.ts'],
    exclude: [...configDefaults.exclude, 'server/node/**/*.test.cjs'],
  },
})
