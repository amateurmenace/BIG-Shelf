/**
 * BIG Equipment — service (server-only)
 *
 * The member "scan to reserve" experience: resolving scanned QR codes /
 * barcodes / SAM IDs to assets, the anonymized per-asset info payload
 * (photo, description, availability, admin-managed guides), guide CRUD for
 * staff, and multi-asset order reservations composed from upstream booking
 * services (so the Neon membership gate, conflict validation, emails, loan
 * agreements, and the Google Calendar mirror all keep firing).
 *
 * Additive (BIG-only) per BIG-FORK.md: `AssetGuide` carries plain
 * `organizationId`/`assetId` columns (no relations on core tables) and every
 * query here is org-scoped.
 *
 * @see {@link file://./shared.ts} — client-safe constants/helpers
 * @see {@link file://./../../routes/_layout+/reserve.scan.tsx} — the member scanner
 * @see {@link file://./../../routes/_layout+/reserve.equipment_.$assetId.tsx} — the info page
 * @see {@link file://./../../routes/_layout+/reserve.order.tsx} — the order checkout
 * @see {@link file://./../../routes/_layout+/assets.$assetId.guides.tsx} — the admin Guides tab
 */
import type {
  Asset,
  AssetGuide,
  Booking,
  Organization,
  User,
} from "@prisma/client";
import { AssetGuideKind, BookingStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "~/database/db.server";
import type { ClientHint } from "~/utils/client-hints";
import { isLikeShelfError, ShelfError } from "~/utils/error";
import {
  createBooking,
  deleteBooking,
  reserveBooking,
  updateBookingAssets,
} from "../booking/service.server";

const label = "Booking" as const;

/** What a scanned code resolved to (member scanner). */
export type ResolvedScan =
  | { kind: "asset"; assetId: string }
  | { kind: "kit" }
  | { kind: "not-found" };

/**
 * Resolves a scanned code to an asset in the member's organization.
 *
 * Accepts the three shapes the shared `CodeScanner` emits:
 * - `type: "qr"` — a shelf QR id (already extracted from the label URL)
 * - `type: "barcode"` — a raw barcode value (Code128/EAN/…)
 * - `type: "samId"` — a sequential asset id like "SAM-0042"
 *
 * SECURITY: every lookup is org-scoped, so a code printed by another
 * workspace resolves to `not-found` here — a member can never pull up
 * another org's asset by scanning its label.
 *
 * @param args.organizationId - The caller's (validated) organization
 * @param args.value - The normalized scanned value from the scanner
 * @param args.type - Which kind of code was scanned
 * @returns What the code points at (asset / kit / nothing)
 * @throws {ShelfError} On database failure
 */
export async function resolveScannedCode({
  organizationId,
  value,
  type,
}: {
  organizationId: Organization["id"];
  value: string;
  type: "qr" | "barcode" | "samId";
}): Promise<ResolvedScan> {
  try {
    const trimmed = value.trim();
    if (!trimmed) {
      return { kind: "not-found" };
    }

    if (type === "qr") {
      const qr = await db.qr.findFirst({
        where: { id: trimmed, organizationId },
        select: { assetId: true, kitId: true },
      });
      if (qr?.assetId) return { kind: "asset", assetId: qr.assetId };
      if (qr?.kitId) return { kind: "kit" };
      return { kind: "not-found" };
    }

    if (type === "barcode") {
      const barcode = await db.barcode.findFirst({
        // Barcode values are stored normalized; org+value is unique.
        where: {
          organizationId,
          value: { equals: trimmed, mode: "insensitive" },
        },
        select: { assetId: true, kitId: true },
      });
      if (barcode?.assetId) return { kind: "asset", assetId: barcode.assetId };
      if (barcode?.kitId) return { kind: "kit" };
      return { kind: "not-found" };
    }

    // samId — the human-readable sequential id printed on some labels.
    const asset = await db.asset.findFirst({
      where: {
        organizationId,
        sequentialId: { equals: trimmed, mode: "insensitive" },
      },
      select: { id: true },
    });
    return asset ? { kind: "asset", assetId: asset.id } : { kind: "not-found" };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while looking up that code",
      additionalData: { organizationId, type },
      label,
    });
  }
}

/**
 * The anonymized equipment info payload for the member info page: the asset's
 * identity + big photo + availability, and its admin-managed guides. Carries
 * NO custody/booking/member names — members see what the gear is and whether
 * it's free, never who has it.
 *
 * @param args.organizationId - The caller's (validated) organization
 * @param args.assetId - The asset to show (from the URL, untrusted)
 * @returns `{ asset, guides }`
 * @throws {ShelfError} 404 when the asset isn't in this org or isn't bookable
 */
export async function getMemberAssetInfo({
  organizationId,
  assetId,
}: {
  organizationId: Organization["id"];
  assetId: Asset["id"];
}) {
  try {
    const asset = await db.asset.findFirst({
      // Members only ever see gear that is offered for booking.
      where: { id: assetId, organizationId, availableToBook: true },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        organizationId: true,
        mainImage: true,
        thumbnailImage: true,
        mainImageExpiration: true,
        category: { select: { name: true, color: true } },
      },
    });

    if (!asset) {
      throw new ShelfError({
        cause: null,
        title: "Equipment not found",
        message:
          "That item doesn't exist in this workspace or isn't available to book.",
        additionalData: { assetId, organizationId },
        status: 404,
        label,
        shouldBeCaptured: false,
      });
    }

    const guides = await listAssetGuides({ organizationId, assetId });

    return { asset, guides };
  } catch (cause) {
    if (isLikeShelfError(cause)) {
      throw cause;
    }
    throw new ShelfError({
      cause,
      message: "Something went wrong while loading the equipment info",
      additionalData: { assetId, organizationId },
      label,
    });
  }
}

/** Lists an asset's guides, display-ordered. Org-scoped. */
export async function listAssetGuides({
  organizationId,
  assetId,
}: {
  organizationId: Organization["id"];
  assetId: Asset["id"];
}): Promise<AssetGuide[]> {
  try {
    return await db.assetGuide.findMany({
      where: { organizationId, assetId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while loading the guides",
      additionalData: { assetId, organizationId },
      label,
    });
  }
}

/** Validates the admin "add guide" form. */
export const AssetGuideSchema = z.object({
  kind: z.nativeEnum(AssetGuideKind),
  title: z.string().trim().min(2, "Give the guide a short title"),
  url: z
    .string()
    .trim()
    .url("Enter the full link, starting with https://")
    .refine((url) => url.startsWith("http"), {
      message: "Enter the full link, starting with https://",
    }),
});

/**
 * Adds a guide to an asset. The asset is proven to belong to the caller's
 * organization first (IDOR guard — the id comes from the URL).
 *
 * @throws {ShelfError} 404 when the asset isn't in this org; 500 on db failure
 */
export async function createAssetGuide({
  organizationId,
  assetId,
  createdById,
  kind,
  title,
  url,
}: {
  organizationId: Organization["id"];
  assetId: Asset["id"];
  createdById: User["id"];
  kind: AssetGuideKind;
  title: string;
  url: string;
}): Promise<AssetGuide> {
  try {
    const asset = await db.asset.findFirst({
      where: { id: assetId, organizationId },
      select: { id: true },
    });
    if (!asset) {
      throw new ShelfError({
        cause: null,
        message: "That asset doesn't exist in this workspace.",
        additionalData: { assetId, organizationId },
        status: 404,
        label,
        shouldBeCaptured: false,
      });
    }

    const last = await db.assetGuide.findFirst({
      where: { organizationId, assetId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });

    return await db.assetGuide.create({
      data: {
        organizationId,
        assetId,
        kind,
        title,
        url,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        createdById,
      },
    });
  } catch (cause) {
    if (isLikeShelfError(cause)) {
      throw cause;
    }
    throw new ShelfError({
      cause,
      message: "Something went wrong while adding the guide",
      additionalData: { assetId, organizationId },
      label,
    });
  }
}

/** Deletes a guide (org-scoped — a foreign id can't delete across tenants). */
export async function deleteAssetGuide({
  id,
  organizationId,
}: {
  id: AssetGuide["id"];
  organizationId: Organization["id"];
}): Promise<void> {
  try {
    await db.assetGuide.delete({ where: { id, organizationId } });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while removing the guide",
      additionalData: { id, organizationId },
      label,
    });
  }
}

/**
 * Creates + reserves a multi-asset equipment order for a member (the checkout
 * for the scan-to-reserve cart).
 *
 * Composes upstream `createBooking` (which runs the BIG Neon membership gate
 * against the creator) → `reserveBooking` (asset conflict validation,
 * confirmation email, calendar hooks) — exactly like the room flow — so every
 * policy keeps applying. A failed reserve deletes the draft so nothing is
 * left behind.
 *
 * SECURITY: every asset id is proven to belong to the org AND to be offered
 * for booking (`availableToBook`) before anything is created.
 *
 * @returns The reserved booking
 * @throws {ShelfError} 400 on empty/invalid asset sets; upstream errors pass through
 */
export async function createEquipmentReservation({
  organizationId,
  assetIds,
  name,
  description,
  from,
  to,
  creatorId,
  custodianTeamMemberId,
  custodianUserId,
  hints,
  isSelfServiceOrBase,
  attachToBookingId,
}: {
  organizationId: Organization["id"];
  assetIds: Asset["id"][];
  name: Booking["name"];
  description?: Booking["description"];
  from: Date;
  to: Date;
  /** The authenticated user creating the reservation (membership gate target). */
  creatorId: User["id"];
  custodianTeamMemberId: string;
  custodianUserId: string | null;
  hints: ClientHint;
  isSelfServiceOrBase: boolean;
  /**
   * BIG: when set, the equipment is ADDED to this existing reservation rather
   * than becoming a new one. Used by the "I also need equipment" path from a
   * room booking, so a member who books a room and then grabs a camera ends up
   * with ONE reservation for the afternoon, not two overlapping ones that each
   * need collecting and returning separately.
   *
   * The booking must belong to the same organization AND to the same person —
   * both are checked below.
   */
  attachToBookingId?: Booking["id"] | null;
}) {
  const uniqueAssetIds = [...new Set(assetIds)];
  if (uniqueAssetIds.length === 0) {
    throw new ShelfError({
      cause: null,
      title: "Your order is empty",
      message: "Add at least one item to your order before reserving.",
      additionalData: { organizationId },
      status: 400,
      label,
      shouldBeCaptured: false,
    });
  }

  // IDOR guard + policy: every id must be this org's bookable gear.
  const owned = await db.asset.count({
    where: {
      id: { in: uniqueAssetIds },
      organizationId,
      availableToBook: true,
    },
  });
  if (owned !== uniqueAssetIds.length) {
    throw new ShelfError({
      cause: null,
      title: "Some items can't be reserved",
      message:
        "One or more items in your order no longer exist or aren't available to book. Remove them and try again.",
      additionalData: { organizationId, assetIds: uniqueAssetIds },
      status: 400,
      label,
      shouldBeCaptured: false,
    });
  }

  /**
   * Attach-to-existing path. Deliberately separate from the create path: it
   * must not touch the booking's name, dates or custodian, only add assets.
   */
  if (attachToBookingId) {
    const target = await db.booking.findFirst({
      where: { id: attachToBookingId, organizationId },
      select: {
        id: true,
        status: true,
        custodianUserId: true,
        custodianTeamMemberId: true,
      },
    });

    if (!target) {
      throw new ShelfError({
        cause: null,
        title: "Reservation not found",
        message:
          "The reservation you are adding to no longer exists. Try making a new one.",
        additionalData: { organizationId, attachToBookingId },
        status: 404,
        label,
        shouldBeCaptured: false,
      });
    }

    // Only the person the reservation belongs to may add to it. Without this,
    // any member could append gear to anyone else's booking by guessing an id.
    const isOwnBooking =
      target.custodianUserId === custodianUserId ||
      target.custodianTeamMemberId === custodianTeamMemberId;
    if (!isOwnBooking) {
      throw new ShelfError({
        cause: null,
        title: "Not allowed",
        message: "You can only add equipment to your own reservation.",
        additionalData: { organizationId, attachToBookingId, creatorId },
        status: 403,
        label,
        shouldBeCaptured: false,
      });
    }

    const attachableStatuses: BookingStatus[] = [
      BookingStatus.DRAFT,
      BookingStatus.RESERVED,
    ];
    if (!attachableStatuses.includes(target.status)) {
      throw new ShelfError({
        cause: null,
        title: "Too late to change this reservation",
        message:
          "This reservation has already started or finished, so equipment can no longer be added to it. Make a new reservation instead.",
        additionalData: { organizationId, attachToBookingId },
        status: 400,
        label,
        shouldBeCaptured: false,
      });
    }

    return updateBookingAssets({
      id: target.id,
      organizationId,
      assetIds: uniqueAssetIds,
      userId: creatorId,
    });
  }

  const draft = await createBooking({
    booking: {
      name,
      description: description ?? null,
      from,
      to,
      custodianTeamMemberId,
      custodianUserId,
      organizationId,
      creatorId,
      tags: [],
    },
    assetIds: uniqueAssetIds,
    hints,
  });

  try {
    return await reserveBooking({
      id: draft.id,
      organizationId,
      name,
      description: description ?? null,
      from,
      to,
      custodianTeamMemberId,
      custodianUserId,
      hints,
      isSelfServiceOrBase,
      tags: [],
      userId: creatorId,
    });
  } catch (cause) {
    // Roll back the draft so the failed attempt leaves nothing behind. The
    // deletion is best-effort: the original error is what the user must see.
    await deleteBooking(
      { id: draft.id, organizationId },
      hints,
      creatorId
    ).catch(() => null);

    if (isLikeShelfError(cause)) {
      throw cause;
    }
    throw new ShelfError({
      cause,
      message: "Something went wrong while reserving your order.",
      additionalData: { organizationId, assetIds: uniqueAssetIds, from, to },
      label,
    });
  }
}
