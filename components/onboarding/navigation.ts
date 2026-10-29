export const ONBOARDING_STEPS = ['index', 'permissions', 'connect', 'general', 'voice', 'ready'] as const;
export type OnboardingStepName = typeof ONBOARDING_STEPS[number];

export function getOnboardingSteps(_hasConnection: boolean) {
  return [...ONBOARDING_STEPS];
}

export function onboardingRoute(step: OnboardingStepName) {
  return step === 'index' ? '/onboarding' : `/onboarding/${step}` as const;
}
