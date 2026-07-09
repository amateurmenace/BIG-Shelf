/**
 * BIG Kiosk Content — client-safe shared pieces
 *
 * Constants, schemas, and types used by BOTH the server service and
 * client-rendered components (the Settings → Kiosk CMS page, the wallboard).
 * Must stay free of server-only imports — `service.server.ts` imports from
 * here, never the other way around.
 *
 * @see {@link file://./service.server.ts}
 */
import { z } from "zod";

/** The wallboard shows at most this many promo cards. */
export const MAX_KIOSK_PROMOS = 3;

/** Validates the membership-card CMS form. */
export const KioskMembershipSchema = z.object({
  membershipHeadline: z
    .string()
    .trim()
    .max(80, "Keep the headline under 80 characters")
    .optional()
    .transform((value) => (value ? value : null)),
  membershipBlurb: z
    .string()
    .trim()
    .max(280, "Keep the welcome message under 280 characters")
    .optional()
    .transform((value) => (value ? value : null)),
  membershipSignupUrl: z
    .union([
      z.literal(""),
      z
        .string()
        .trim()
        .url("Enter the full sign-up link, starting with https://"),
    ])
    .optional()
    .transform((value) => (value ? value : null)),
});

/** The kiosk month-calendar's closed-days feed. Dates are "YYYY-MM-DD" keys. */
export type KioskClosedDays = {
  /** False when the org hasn't enabled Working Hours (nothing to show). */
  enabled: boolean;
  /** JS weekday numbers (0=Sun…6=Sat) that are closed every week. */
  weeklyClosedWeekdays: number[];
  /** Date-specific closures within the horizon, with the admin's reason. */
  closedOverrides: { date: string; reason: string | null }[];
};
