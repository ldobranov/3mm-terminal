export default {
  test: {
    environment: 'node',
    include: ['tests/frontend/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
}