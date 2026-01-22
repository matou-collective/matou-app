import { configure } from 'quasar/wrappers';
import path from 'path';

export default configure(() => {
  return {
    boot: ['motion', 'keri'],

    css: ['app.scss'],

    extras: ['roboto-font', 'material-icons'],

    build: {
      target: {
        browser: ['es2022', 'firefox115', 'chrome115', 'safari14'],
        node: 'node20',
      },
      vueRouterMode: 'hash',
      alias: {
        src: path.join(__dirname, 'src'),
        components: path.join(__dirname, 'src/components'),
        composables: path.join(__dirname, 'src/composables'),
        layouts: path.join(__dirname, 'src/layouts'),
        pages: path.join(__dirname, 'src/pages'),
        stores: path.join(__dirname, 'src/stores'),
      },
      extendViteConf(viteConf) {
        // Handle signify-ts dependencies that need special bundling
        viteConf.optimizeDeps = viteConf.optimizeDeps || {};
        viteConf.optimizeDeps.include = viteConf.optimizeDeps.include || [];
        viteConf.optimizeDeps.include.push(
          'signify-ts',
          'libsodium-wrappers-sumo',
          'libsodium-sumo'
        );
        viteConf.optimizeDeps.esbuildOptions = {
          target: 'es2022',
        };

        // Force use of CommonJS versions for libsodium packages to avoid ESM resolution issues
        viteConf.resolve = viteConf.resolve || {};
        viteConf.resolve.alias = {
          ...viteConf.resolve.alias,
          // Force CommonJS version to avoid missing libsodium-sumo.mjs issue
          'libsodium-wrappers-sumo':
            path.join(__dirname, 'node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js'),
        };

        // Handle build-time issues with signify-ts
        viteConf.build = viteConf.build || {};
        viteConf.build.commonjsOptions = {
          ...viteConf.build.commonjsOptions,
          include: [/signify-ts/, /libsodium/, /node_modules/],
          transformMixedEsModules: true,
        };
      },
    },

    devServer: {
      open: true,
    },

    framework: {
      config: {},
      plugins: ['Notify'],
    },

    animations: [],

    ssr: {
      pwa: false,
      prodPort: 3000,
      middlewares: ['render'],
    },

    pwa: {
      workboxMode: 'GenerateSW',
    },

    capacitor: {
      hideSplashscreen: true,
    },

    electron: {
      preloadScripts: ['electron-preload'],
      inspectPort: 5858,
      bundler: 'packager',
    },

    bex: {
      extraScripts: [],
    },
  };
});
