import {
  COLLECT_BUSINESS_INTEL,
  DISABLE_SIGNUP,
  DISABLE_SSO,
  ENABLE_PREMIUM_FEATURES,
  FREE_TRIAL_DAYS,
  GEOCODING_USER_AGENT,
  SEND_ONBOARDING_EMAIL,
  SHOW_HOW_DID_YOU_FIND_US,
} from "~/utils/env";
import { Config } from "./types";

export const config: Config = {
  sendOnboardingEmail: SEND_ONBOARDING_EMAIL || false,
  enablePremiumFeatures: ENABLE_PREMIUM_FEATURES || false,
  freeTrialDays: Number(FREE_TRIAL_DAYS || 7),
  disableSignup: DISABLE_SIGNUP || false,
  disableSSO: DISABLE_SSO || false,

  // BIG: BIG Shelf branding — rainbow arc + wordmark. fullLogo carries a dark
  // wordmark for light surfaces (email, auth, mobile header); fullLogoLight a
  // light wordmark for the dark indigo sidebar; symbol is the universal arc.
  logoPath: {
    fullLogo: "/static/images/big/big-shelf-full.png",
    symbol: "/static/images/big/big-shelf-symbol.png",
    fullLogoLight: "/static/images/big/big-shelf-full-light.png",
  },
  faviconPath: "/static/images/big/big-shelf-favicon.png",
  // BIG: brand magenta (AA-tuned, matches primary-500) replaces Shelf orange
  emailPrimaryColor: "#BE4598",
  showHowDidYouFindUs: SHOW_HOW_DID_YOU_FIND_US || false,
  collectBusinessIntel:
    COLLECT_BUSINESS_INTEL || SHOW_HOW_DID_YOU_FIND_US || false,
  geocoding: {
    userAgent: GEOCODING_USER_AGENT || "Self-hosted Asset Management System",
  },
};
