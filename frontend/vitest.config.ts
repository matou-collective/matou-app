import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve 'src/*' imports (mirrors tsconfig paths)
      src: path.join(__dirname, 'src'),
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
    testTimeout: 120000,
    server: {
      deps: {
        inline: ['signify-ts', 'libsodium-wrappers-sumo'],
      },
    },
  },
});
