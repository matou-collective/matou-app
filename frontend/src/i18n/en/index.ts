/**
 * English catalogue (#783) — the authoritative source of truth. Every key
 * added here must be mirrored into every other locale (the parity guard
 * enforces this in CI); `en` always wins over an unreviewed draft.
 */
import common from './common';
import language from './language';
import setup from './setup';

export default {
  common,
  language,
  setup,
};
