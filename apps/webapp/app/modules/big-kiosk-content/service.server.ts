/**
 * BIG Kiosk Content — service (server-only)
 *
 * Admin-managed content for the public `/kiosk` wallboard, edited on the
 * Settings → Kiosk CMS page:
 * - up to {@link MAX_KIOSK_PROMOS} class/event promo cards (uploaded image +
 *   sign-up link rendered as a QR code on the wall),
 * - the welcoming "become a member" card (headline / blurb / sign-up URL),
 * - the closed-days feed for the kiosk's month calendar, derived from the
 *   org's existing Working Hours (weekly closed days + date overrides) so
 *   there is ONE source of truth for "when is BIG closed".
 *
 * Additive (BIG-only): `KioskPromo` / `KioskConfig` carry plain
 * `organizationId` columns (no relations on core tables) and every query is
 * org-scoped. Images reuse shelf's public-bucket upload pipeline.
 *
 * @see {@link file://./../../routes/_layout+/settings.kiosk.tsx} — the CMS page
 * @see {@link file://./../../routes/kiosk.tsx} — the wallboard that renders this
 * @see {@link file://./../big-asset-condition/service.server.ts} — the upload pattern mirrored here
 */
import { createId } from "@paralleldrive/cuid2";
import type {
  KioskConfig,
  KioskPromo,
  Organization,
  User,
} from "@prisma/client";
import { z } from "zod";
import { db } from "~/database/db.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import { getWorkingHoursForOrganization } from "~/modules/working-hours/service.server";
import {
  getOverrideDateKey,
  normalizeWorkingHoursForValidation,
} from "~/modules/working-hours/utils";
import {
  DEFAULT_MAX_IMAGE_UPLOAD_SIZE,
  PUBLIC_BUCKET,
} from "~/utils/constants";
import { isLikeShelfError, ShelfError } from "~/utils/error";
import { parseFileFormData } from "~/utils/storage.server";
import { MAX_KIOSK_PROMOS, splitKioskNews } from "./shared";
import type { KioskClosedDays } from "./shared";

const label = "Kiosk" as const;

// Client-safe pieces live in ./shared; re-exported for server-side callers.
export { MAX_KIOSK_PROMOS, splitKioskNews };
export type { KioskClosedDays };

/** Validates the promo form fields (parsed alongside the uploaded image). */
const PromoSchema = z.object({
  title: z.string().trim().min(2, "Give the promo a title"),
  linkUrl: z
    .string()
    .trim()
    .url("Enter the full sign-up link, starting with https://")
    .refine((url) => url.startsWith("http"), {
      message: "Enter the full sign-up link, starting with https://",
    }),
  // <input type="date"> wire format; empty means "no date on the card".
  eventDate: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : null))
    .refine((value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value), {
      message: "Enter the event date as a calendar date",
    }),
});

/**
 * Lists the org's promo cards, display-ordered, capped at
 * {@link MAX_KIOSK_PROMOS}.
 */
export async function getKioskPromos({
  organizationId,
}: {
  organizationId: Organization["id"];
}): Promise<KioskPromo[]> {
  try {
    return await db.kioskPromo.findMany({
      where: { organizationId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      take: MAX_KIOSK_PROMOS,
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while loading the kiosk promos",
      additionalData: { organizationId },
      label,
    });
  }
}

/**
 * Creates a promo card from a multipart form submission: uploads the image to
 * the public bucket, validates the text fields, and stores the card. Rejects
 * with a 400 when the org already has {@link MAX_KIOSK_PROMOS} cards (checked
 * BEFORE the upload so we never orphan a file for a doomed submission).
 *
 * `eventDate` is stored as UTC midnight of the picked calendar date; readers
 * must format it as an absolute date (UTC), never in a local zone.
 *
 * @throws {ShelfError} 400 on validation/limit failures, 500 on upload/db errors
 */
export async function createKioskPromoFromRequest({
  request,
  organizationId,
  createdById,
}: {
  request: Request;
  organizationId: Organization["id"];
  createdById: User["id"];
}): Promise<KioskPromo> {
  try {
    const existingCount = await db.kioskPromo.count({
      where: { organizationId },
    });
    if (existingCount >= MAX_KIOSK_PROMOS) {
      throw new ShelfError({
        cause: null,
        message: `The kiosk shows up to ${MAX_KIOSK_PROMOS} promos — remove one before adding another.`,
        additionalData: { organizationId },
        label,
        status: 400,
        shouldBeCaptured: false,
      });
    }

    // Parse the multipart body once; this uploads the image to the public
    // bucket and passes the text fields through.
    const imagePathBase = `${organizationId}/kiosk-promos/${createId()}`;
    const formData = await parseFileFormData({
      request,
      bucketName: PUBLIC_BUCKET,
      newFileName: imagePathBase,
      // Wallboard cards render large — keep generous width, no thumbnail.
      resizeOptions: { width: 1600, withoutEnlargement: true },
      maxFileSize: DEFAULT_MAX_IMAGE_UPLOAD_SIZE,
    });

    const parsed = PromoSchema.safeParse({
      title: formData.get("title"),
      linkUrl: formData.get("linkUrl"),
      eventDate: formData.get("eventDate") ?? undefined,
    });
    if (!parsed.success) {
      throw new ShelfError({
        cause: parsed.error,
        message:
          parsed.error.issues[0]?.message ?? "Please complete the promo form.",
        label,
        status: 400,
        shouldBeCaptured: false,
      });
    }

    const imagePath = formData.get("image") as string | null;
    if (!imagePath) {
      throw new ShelfError({
        cause: null,
        message: "Please choose an image for the promo.",
        label,
        status: 400,
        shouldBeCaptured: false,
      });
    }

    const {
      data: { publicUrl: imageUrl },
    } = getSupabaseAdmin().storage.from(PUBLIC_BUCKET).getPublicUrl(imagePath);

    return await db.kioskPromo.create({
      data: {
        organizationId,
        title: parsed.data.title,
        linkUrl: parsed.data.linkUrl,
        eventDate: parsed.data.eventDate
          ? new Date(`${parsed.data.eventDate}T00:00:00.000Z`)
          : null,
        imageUrl,
        imagePath,
        sortOrder: existingCount,
        createdById,
      },
    });
  } catch (cause) {
    if (isLikeShelfError(cause)) {
      throw cause;
    }
    throw new ShelfError({
      cause,
      message: "Something went wrong while adding the kiosk promo",
      additionalData: { organizationId, createdById },
      label,
    });
  }
}

/**
 * Deletes a promo card (org-scoped) and best-effort removes its image from
 * storage — a leftover file must never block the delete.
 */
export async function deleteKioskPromo({
  id,
  organizationId,
}: {
  id: KioskPromo["id"];
  organizationId: Organization["id"];
}): Promise<void> {
  try {
    // Org-scoped delete: the where clause proves ownership, so a foreign id
    // can never delete another workspace's promo.
    const promo = await db.kioskPromo.delete({
      where: { id, organizationId },
      select: { imagePath: true },
    });

    await getSupabaseAdmin()
      .storage.from(PUBLIC_BUCKET)
      .remove([promo.imagePath])
      .catch(() => null);
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while removing the kiosk promo",
      additionalData: { id, organizationId },
      label,
    });
  }
}

/** Loads the org's kiosk config (membership card copy), or null when unset. */
export async function getKioskConfig({
  organizationId,
}: {
  organizationId: Organization["id"];
}): Promise<KioskConfig | null> {
  try {
    return await db.kioskConfig.findUnique({ where: { organizationId } });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while loading the kiosk settings",
      additionalData: { organizationId },
      label,
    });
  }
}

/** The kiosk-config fields the CMS can patch (membership card + news). */
type KioskConfigPatch = Partial<
  Pick<
    KioskConfig,
    | "membershipHeadline"
    | "membershipBlurb"
    | "membershipSignupUrl"
    | "newsMessages"
  >
>;

/**
 * Creates or updates the org's kiosk config with a partial patch, so the CMS's
 * separate membership-card and news forms each write only their own fields
 * without clobbering the other. Clearing the sign-up URL hides the membership
 * card on the wallboard (the QR needs a target to render); clearing news hides
 * the banner.
 *
 * @param args.patch - Only the fields to change; omitted fields are untouched
 */
export async function upsertKioskConfig({
  organizationId,
  updatedById,
  patch,
}: {
  organizationId: Organization["id"];
  updatedById: User["id"];
  patch: KioskConfigPatch;
}): Promise<KioskConfig> {
  try {
    const existing = await db.kioskConfig.findUnique({
      where: { organizationId },
      select: { id: true },
    });

    if (existing) {
      return await db.kioskConfig.update({
        where: { organizationId },
        data: { ...patch, updatedById },
      });
    }

    return await db.kioskConfig.create({
      data: { organizationId, ...patch, updatedById },
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while saving the kiosk settings",
      additionalData: { organizationId },
      label,
    });
  }
}

/**
 * Derives "when is BIG closed" from the org's Working Hours so the kiosk
 * calendar and the booking validation can never disagree. Weekly closed days
 * come from the weekly schedule; holiday closures come from the date
 * overrides (admins manage both under Settings → Bookings).
 *
 * @param args.horizonDays - How far ahead to include date overrides (default
 *   62 ≈ the current + next month, matching what the calendar can show)
 */
export async function getKioskClosedDays({
  organizationId,
  horizonDays = 62,
}: {
  organizationId: Organization["id"];
  horizonDays?: number;
}): Promise<KioskClosedDays> {
  try {
    const raw = await getWorkingHoursForOrganization(organizationId);
    const workingHours = normalizeWorkingHoursForValidation(raw);

    if (!workingHours || !workingHours.enabled) {
      return { enabled: false, weeklyClosedWeekdays: [], closedOverrides: [] };
    }

    const weeklyClosedWeekdays = Object.entries(workingHours.weeklySchedule)
      .filter(([, day]) => !day || !day.isOpen)
      .map(([weekday]) => Number(weekday))
      .filter((weekday) => Number.isInteger(weekday));

    // "YYYY-MM-DD" keys compare correctly as strings.
    const todayKey = new Date().toISOString().slice(0, 10);
    const horizonKey = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const closedOverrides = workingHours.overrides
      .filter((override) => !override.isOpen)
      .map((override) => ({
        date: getOverrideDateKey(override.date),
        reason: override.reason ?? null,
      }))
      .filter(
        (override) => override.date >= todayKey && override.date <= horizonKey
      )
      .sort((a, b) => a.date.localeCompare(b.date));

    return { enabled: true, weeklyClosedWeekdays, closedOverrides };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while loading the closed days",
      additionalData: { organizationId },
      label,
    });
  }
}
