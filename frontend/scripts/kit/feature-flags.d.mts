export interface KitFeatures {
  chat?: boolean;
  projects?: boolean;
  proposals?: boolean;
  notices?: boolean;
  [key: string]: unknown;
}

export interface KitFeatureDefines {
  __KIT_CHAT__: string;
  __KIT_PROJECTS__: string;
  __KIT_PROPOSALS__: string;
  __KIT_NOTICES__: string;
}

export function featureDefines(features?: KitFeatures): KitFeatureDefines;
