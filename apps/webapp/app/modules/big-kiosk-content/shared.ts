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

/** The kiosk rotates through at most this many news lines. */
export const MAX_KIOSK_NEWS = 5;

/** Max characters per news line (keeps the banner readable on the wall). */
const MAX_NEWS_LINE_LENGTH = 200;

/**
 * Normalizes a raw multiline news textarea into stored form: one message per
 * line, trimmed, blanks dropped, capped at {@link MAX_KIOSK_NEWS} lines each
 * ≤ {@link MAX_NEWS_LINE_LENGTH} chars. Returns null when nothing survives
 * (which hides the banner).
 */
export function normalizeKioskNews(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_KIOSK_NEWS)
    .map((line) => line.slice(0, MAX_NEWS_LINE_LENGTH));
  return lines.length ? lines.join("\n") : null;
}

/** Splits stored news back into an array of message lines for rendering. */
export function splitKioskNews(stored: string | null | undefined): string[] {
  if (!stored) return [];
  return stored
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Validates the news/announcements CMS form (one message per line). */
export const KioskNewsSchema = z.object({
  newsMessages: z
    .string()
    .max(2000, "That's a lot of news — keep it under 2000 characters")
    .optional()
    .transform((value) => normalizeKioskNews(value)),
});

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

/**
 * True when the given calendar day is closed per the org's Working Hours —
 * either a weekly closed weekday or a date-specific closure override. Used by
 * the kiosk wallboard and the member dashboard so "is BIG closed that day?"
 * is answered the same way everywhere.
 *
 * @param closedDays - The feed from `getKioskClosedDays`
 * @param dateKey - The day as a "YYYY-MM-DD" key
 * @param jsWeekday - The day's JS weekday number (0=Sun…6=Sat; Luxon callers
 *   pass `day.weekday % 7`)
 */
export function isDateClosed(
  closedDays: KioskClosedDays,
  dateKey: string,
  jsWeekday: number
): boolean {
  if (!closedDays.enabled) return false;
  return (
    closedDays.weeklyClosedWeekdays.includes(jsWeekday) ||
    closedDays.closedOverrides.some((override) => override.date === dateKey)
  );
}
