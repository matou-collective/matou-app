/**
 * Vite `define` replacements for the kit's module toggles (coa phase-4 spec
 * §3.2). Being compile-time constant is what lets Rollup drop a disabled
 * module's route records — and with them the dynamic-import chunks — from the
 * bundle entirely. Values must be code strings, per Vite's define contract.
 */
export function featureDefines(features = {}) {
  const flag = (v) => JSON.stringify(v === true);
  return {
    __KIT_CHAT__: flag(features.chat),
    __KIT_PROJECTS__: flag(features.projects),
    __KIT_PROPOSALS__: flag(features.proposals),
    __KIT_NOTICES__: flag(features.notices),
  };
}
