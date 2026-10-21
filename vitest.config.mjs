import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

export default {
  plugins: [vue()],
  resolve: {
    alias: {
      '@3mm/application-ui/v1': fileURLToPath(new URL('./tests/frontend/fixtures/applicationHost.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/frontend/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
}
