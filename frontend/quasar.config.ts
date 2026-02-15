import { configure } from 'quasar/wrappers';
import path from 'path';
import fs from 'fs';

// Load .env.production vars for electron main process injection
function loadEnvFile(filename: string): Record<string, string> {
  const envPath = path.join(__dirname, filename);
  if (!fs.existsSync(envPath)) return {};
  const vars: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return vars;
}
const prodEnv = loadEnvFile('.env.production');

export default configure(() => {
  return {
    boot: ['motion', 'keri'],

    css: ['app.scss', 'tailwind.css'],

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
      bundler: 'builder',
      extendElectronMainConf(esbuildConf) {
        esbuildConf.define = {
          ...esbuildConf.define,
          'process.env.PROD_CONFIG_SERVER_URL': JSON.stringify(prodEnv.VITE_PROD_CONFIG_URL || ''),
          'process.env.PROD_SMTP_HOST': JSON.stringify(prodEnv.VITE_SMTP_HOST || ''),
          'process.env.PROD_SMTP_PORT': JSON.stringify(prodEnv.VITE_SMTP_PORT || ''),
          'process.env.QUASAR_ELECTRON_PRELOAD': JSON.stringify('preload/electron-preload.cjs'),
        };
      },
      builder: {
        appId: 'org.matou.app',
        productName: 'Matou',
        artifactName: 'matou-${version}.${ext}',
        afterPack: './build/afterPack.cjs',
        extraResources: [
          { from: '../backend/bin/', to: 'backend/' },
          { from: 'src-electron/icons/', to: 'icons/' },
        ],
        mac: {
          target: 'zip',
          identity: null, // Skip code signing (unsigned build)
          icon: 'src-electron/icons/icon.png',
        },
        linux: {
          target: 'AppImage',
          icon: 'src-electron/icons',
          category: 'Network',
          executableName: 'matou',
          executableArgs: ['--no-sandbox'],
        },
        win: {
          target: 'nsis',
          icon: 'src-electron/icons/icon.png',
        },
      },
    },

    bex: {
      extraScripts: [],
    },
  };
});
