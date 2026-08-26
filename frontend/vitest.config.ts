import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve 'src/*' imports (mirrors tsconfig paths)
      src: path.join(__dirname, 'src'),
      // Mirror the remaining tsconfig path aliases so tests can import modules
      // that reference them transitively (e.g. client.ts -> stores/identity).
      stores: path.join(__dirname, 'src/stores'),
      components: path.join(__dirname, 'src/components'),
      composables: path.join(__dirname, 'src/composables'),
      layouts: path.join(__dirname, 'src/layouts'),
      pages: path.join(__dirname, 'src/pages'),
      // Force CommonJS version to avoid missing libsodium-sumo.mjs ESM issue
      // (same workaround as quasar.config.ts)
      'libsodium-wrappers-sumo': path.join(
        __dirname,
        'node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js'
      ),
    },
  },
  optimizeDeps: {
    include: ['signify-ts', 'libsodium-wrappers-sumo', 'libsodium-sumo'],
  },
  test: {
    // Test scripts live outside src/
    include: ['tests/scripts/**/*.ts'],
    exclude: [
      'tests/scripts/health-check.ts',
      // These need live KERI test infrastructure (localhost:4901/4903/4904) —
      // absent in CI. Run with the infra up via `npm run test:infra`.
      ...(process.env.TEST_INFRA
        ? []
        : ['tests/scripts/test-oobi-messaging.ts', 'tests/scripts/create-test-aid.ts']),
    ],
    testTimeout: 120000,
    server: {
      deps: {
        inline: ['signify-ts', 'libsodium-wrappers-sumo'],
      },
    },
  },
});
