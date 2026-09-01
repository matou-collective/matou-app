// Mirrors @coa/schema KitSchema (Matou/coa packages/schema/src/kit.ts). Keep in sync by hand.
export interface KitBrand {
  name: string;
  slug: string;
  primaryColour: string;
  secondaryColour: string;
  tagline?: string;
  welcomeText?: string;
  contactEmail: string;
}
export type KitApproval =
  | { mode: 'open' }
  | { mode: 'admin' }
  | { mode: 'endorsements'; required: number; admin: boolean }
  | { mode: 'endorsements+session'; required: number; admin: boolean };
export type KitCustomQuestion =
  | { type: 'text'; label: string }
  | { type: 'select'; label: string; options: string[] }
  | { type: 'multiselect'; label: string; options: string[] };
export interface KitProfile {
  fields: { photo: boolean; email: boolean; bio: boolean; location: boolean; whyJoin: boolean; interests: boolean };
  customQuestions: KitCustomQuestion[];
  interestOptions: string[];
}
export interface KitOnboarding {
  welcome: { heading: string; bodyMarkdown: string; heroImage?: string };
  profile: KitProfile;
  approval: KitApproval;
  pending: { heading: string; bodyMarkdown: string; nextSteps: string };
  infoPages: { title: string; bodyMarkdown: string }[];
}
export interface KitFeatures {
  identity: true; chat: boolean; projects: boolean; proposals: boolean; notices: boolean; events: boolean;
  maramataka: boolean; order: string[];
}
export type KitBackend = { kind: 'self-hosted'; configServerUrl: string } | { kind: 'shared'; feeAcknowledged: true };
export interface Kit {
  version: 1;
  slug: string;
  build: number;
  configUrl: string;
  logoFile: 'logo.svg' | 'logo.png';
  brand: KitBrand;
  onboarding: KitOnboarding;
  features: KitFeatures;
  backend: KitBackend;
}
export interface KitBuild {
  appId: string;
  productName: string;
  artifactBase: string;
  executableName: string;
  /** Valid Android package name: slug hyphens → '_', digit-leading segment prefixed with '_'. */
  androidApplicationId: string;
  /** Custom URL scheme (Capacitor `custom_url_scheme`) — keeps the hyphenated slug; '_' is illegal in a scheme. */
  urlScheme: string;
  publish: Record<string, unknown>[] | null;
  updates: boolean;
  primaryColour: string;
  backgroundColour: string;
}
