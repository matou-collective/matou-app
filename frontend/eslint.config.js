// ESLint 9 flat config (CJS — package.json has no "type": "module").
// Scope matches the lint script: `eslint ./src` over .ts and .vue sources.
const js = require('@eslint/js');
const pluginVue = require('eslint-plugin-vue');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const globals = require('globals');

const tsRules = {
  ...tsPlugin.configs.recommended.rules,
  // TypeScript itself checks undefined identifiers; ESLint's no-undef
  // false-positives on TS types and .vue script setup macros.
  'no-undef': 'off',
  'no-unused-vars': 'off',
  // Baseline for the existing codebase: `any` is pervasive and unused vars
  // are widespread — warn keeps the signal without blocking CI. Tighten to
  // error once the backlog is cleaned up.
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
};

module.exports = [
  {
    ignores: ['dist/**', '.quasar/**', 'node_modules/**', 'src-capacitor/**', 'src-cordova/**'],
  },

  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: tsRules,
  },

  {
    // .vue single-file components: vue-eslint-parser (set by the plugin-vue
    // flat config above) owns the file; the TS parser handles <script lang="ts">.
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: tsRules,
  },
];
