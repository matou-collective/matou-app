// Bootstrap flat config (ESLint 9): the repo predates flat config and never
// had a lint config at all. Vue essential rules only; @typescript-eslint is
// registered (rules off) so existing inline disable directives resolve.
// Tighten incrementally — don't add rule packs without fixing their findings.
import vue from 'eslint-plugin-vue';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  ...vue.configs['flat/essential'],
  {
    plugins: { '@typescript-eslint': tsPlugin },
  },
  { files: ['**/*.ts', '**/*.mts'], languageOptions: { parser: tsParser } },
  { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: tsParser } } },
];
