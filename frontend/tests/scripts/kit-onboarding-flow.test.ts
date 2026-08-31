import { describe, it, expect } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useOnboardingStore } from 'stores/onboarding';
import { nextRegisterScreen, prevRegisterScreen } from 'src/kit/onboarding-flow';

describe('register flow from the kit', () => {
  it('walks welcome → N info pages → profile form', () => {
    setActivePinia(createPinia());
    const store = useOnboardingStore();
    const pages = 2;
    expect(nextRegisterScreen('kit-welcome', 0, pages)).toEqual({ screen: 'info-page', index: 0 });
    expect(nextRegisterScreen('info-page', 0, pages)).toEqual({ screen: 'info-page', index: 1 });
    expect(nextRegisterScreen('info-page', 1, pages)).toEqual({ screen: 'profile-form', index: 0 });
    expect(nextRegisterScreen('kit-welcome', 0, 0)).toEqual({ screen: 'profile-form', index: 0 });
    expect(prevRegisterScreen('profile-form', 0, pages)).toEqual({ screen: 'info-page', index: 1 });
    expect(prevRegisterScreen('info-page', 0, pages)).toEqual({ screen: 'kit-welcome', index: 0 });
    expect(prevRegisterScreen('kit-welcome', 0, pages)).toEqual({ screen: 'splash', index: 0 });
    void store;
  });
});
