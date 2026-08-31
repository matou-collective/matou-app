// Pure transition logic for the register onboarding flow driven by the kit's
// info pages. Kept DOM-free so the walk can be unit tested without a store or
// component (see tests/scripts/kit-onboarding-flow.test.ts).
//
// Flow: splash → kit-welcome → (info-page × N) → profile-form → …
export type FlowStep = { screen: 'kit-welcome' | 'info-page' | 'profile-form' | 'splash'; index: number };

export function nextRegisterScreen(current: string, index: number, pages: number): FlowStep {
  if (current === 'kit-welcome') return pages > 0 ? { screen: 'info-page', index: 0 } : { screen: 'profile-form', index: 0 };
  if (current === 'info-page') return index + 1 < pages ? { screen: 'info-page', index: index + 1 } : { screen: 'profile-form', index: 0 };
  return { screen: 'profile-form', index: 0 };
}

export function prevRegisterScreen(current: string, index: number, pages: number): FlowStep {
  if (current === 'profile-form') return pages > 0 ? { screen: 'info-page', index: pages - 1 } : { screen: 'kit-welcome', index: 0 };
  if (current === 'info-page') return index > 0 ? { screen: 'info-page', index: index - 1 } : { screen: 'kit-welcome', index: 0 };
  return { screen: 'splash', index: 0 };
}
