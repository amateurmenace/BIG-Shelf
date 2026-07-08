/**
 * BIG Equipment Waitlists — server service
 *
 * A member joins the waitlist for an asset that is currently unavailable; when
 * the asset frees up (a booking is cancelled / checked in / deleted), the
 * earliest waiting member is emailed "it's available now". Event-driven — the
 * notify hook is called from the booking lifecycle, not a timer.
 *
 * Additive & BIG-only: the `Waitlist` model uses plain FK columns (no relations
 * on Asset/User), so everything here is org-scoped in the app layer via the
 * shared guards.
 *
 * @see {@link file://./../../../packages/database/prisma/schema.prisma} — Waitlist model
 * @see {@link file://./../booking/service.server.ts} — cancel/checkin/delete call the notify hook
 * @see {@link file://./../../routes/_layout+/reserve.tsx} — member join/cancel UI
 */
import { WaitlistStatus } from "@prisma/client";
import { db } from "~/database/db.server";
import { sendEmail } from "~/emails/mail.server";
import { SERVER_URL } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { assertAssetsBelongToOrg } from "~/utils/org-validation.server";

const label = "Waitlist" as const;

/** Days a waitlist entry stays "interested" before it's treated as stale. */
const WAITLIST_INTEREST_DAYS = 30;

/** A member's waitlist entry joined with its (plain-FK) asset, for display. */
export type MemberWaitlistEntry = {
  id: string;
  status: WaitlistStatus;
  createdAt: Date;
  notifiedAt: Date | null;
  asset: { id: string; title: string; status: string } | null;
};

/**
 * Adds the member to the waitlist for an asset. Idempotent: if the member
 * already has an active (WAITING) entry for the asset, that entry is returned
 * unchanged. The asset id is proven to belong to the caller's org first.
 *
 * @param args.organizationId - The caller's workspace
 * @param args.assetId - The (user-supplied) asset to wait for
 * @param args.requestedByUserId - The member's user id (the session user)
 * @returns `{ id }` of the WAITING waitlist entry
 * @throws {ShelfError} If the asset is not in the caller's org
 */
export async function joinWaitlist({
  organizationId,
  assetId,
  requestedByUserId,
}: {
  organizationId: string;
  assetId: string;
  requestedByUserId: string;
}): Promise<{ id: string }> {
  // User-supplied id — prove org ownership before writing (IDOR guard).
  await assertAssetsBelongToOrg({ assetIds: [assetId], organizationId });

  const existing = await db.waitlist.findFirst({
    where: {
      organizationId,
      assetId,
      requestedByUserId,
      status: WaitlistStatus.WAITING,
    },
    select: { id: true },
  });
  if (existing) {
    return existing;
  }

  const from = new Date();
  const to = new Date(
    from.getTime() + WAITLIST_INTEREST_DAYS * 24 * 60 * 60 * 1000
  );

  return db.waitlist.create({
    data: {
      organizationId,
      assetId,
      requestedByUserId,
      from,
      to,
      status: WaitlistStatus.WAITING,
    },
    select: { id: true },
  });
}

/**
 * Lists a member's own active/notified waitlist entries, joined to each asset's
 * title + status (the `Waitlist` model has no Prisma relation to Asset, so we
 * resolve assets in a second org-scoped query).
 *
 * @param args.organizationId - The caller's workspace
 * @param args.userId - The member (session user id)
 * @returns The member's waitlist entries, newest first
 */
export async function getMemberWaitlist({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}): Promise<MemberWaitlistEntry[]> {
  const entries = await db.waitlist.findMany({
    where: {
      organizationId,
      requestedByUserId: userId,
      status: { in: [WaitlistStatus.WAITING, WaitlistStatus.NOTIFIED] },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      createdAt: true,
      notifiedAt: true,
      assetId: true,
    },
  });

  const assetIds = [...new Set(entries.map((entry) => entry.assetId))];
  const assets = await db.asset.findMany({
    where: { id: { in: assetIds }, organizationId },
    select: { id: true, title: true, status: true },
  });
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));

  return entries.map(({ assetId, ...entry }) => ({
    ...entry,
    asset: assetById.get(assetId) ?? null,
  }));
}

/**
 * Cancels a member's own waitlist entry. Scoped to org + owner so a member can
 * never cancel someone else's entry (the id is user-supplied).
 *
 * @param args.id - The (user-supplied) waitlist entry id
 * @param args.organizationId - The caller's workspace
 * @param args.userId - The member (session user id)
 * @throws {ShelfError} 404 if no matching owned entry exists
 */
export async function cancelWaitlistEntry({
  id,
  organizationId,
  userId,
}: {
  id: string;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const result = await db.waitlist.updateMany({
    where: { id, organizationId, requestedByUserId: userId },
    data: { status: WaitlistStatus.CANCELLED },
  });

  if (result.count === 0) {
    throw new ShelfError({
      cause: null,
      message: "That waitlist entry could not be found.",
      label,
      status: 404,
      shouldBeCaptured: false,
    });
  }
}

/**
 * Event hook: given asset ids that just became available (a booking was
 * cancelled / checked in / deleted), email the EARLIEST waiting member per asset
 * that it's now available, and mark those entries NOTIFIED. First-come,
 * first-served. Best-effort by design — callers invoke this non-blocking so a
 * notify failure never breaks the booking operation.
 *
 * @param args.organizationId - The workspace the freed assets belong to
 * @param args.assetIds - Asset ids whose status just returned to AVAILABLE
 * @returns The number of members notified
 */
export async function notifyWaitlistForFreedAssets({
  organizationId,
  assetIds,
}: {
  organizationId: string;
  assetIds: string[];
}): Promise<number> {
  if (assetIds.length === 0) {
    return 0;
  }

  const now = new Date();

  const entries = await db.waitlist.findMany({
    where: {
      organizationId,
      assetId: { in: assetIds },
      status: WaitlistStatus.WAITING,
      to: { gte: now }, // skip stale interest windows
    },
    orderBy: { createdAt: "asc" }, // earliest joined = first served
    select: { id: true, assetId: true, requestedByUserId: true },
  });
  if (entries.length === 0) {
    return 0;
  }

  // Only the earliest waiter per asset is notified.
  const firstPerAsset = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    if (!firstPerAsset.has(entry.assetId)) {
      firstPerAsset.set(entry.assetId, entry);
    }
  }
  const toNotify = [...firstPerAsset.values()];

  const assets = await db.asset.findMany({
    where: { id: { in: toNotify.map((e) => e.assetId) }, organizationId },
    select: { id: true, title: true },
  });
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const users = await db.user.findMany({
    where: { id: { in: toNotify.map((e) => e.requestedByUserId) } },
    select: { id: true, email: true, firstName: true },
  });
  const userById = new Map(users.map((user) => [user.id, user]));

  let notified = 0;
  for (const entry of toNotify) {
    const asset = assetById.get(entry.assetId);
    const user = userById.get(entry.requestedByUserId);
    if (!asset || !user?.email) {
      continue;
    }

    // Mark NOTIFIED before sending so a transient error can't re-notify in a loop.
    await db.waitlist.update({
      // eslint-disable-next-line local-rules/require-org-scope-on-id-queries -- idor-safe: entry.id came from the org-scoped findMany above (where.organizationId); update() can only key on the unique id
      where: { id: entry.id },
      data: { status: WaitlistStatus.NOTIFIED, notifiedAt: new Date() },
    });

    const reserveUrl = `${SERVER_URL}/assets/${asset.id}/overview/create-new-booking`;
    // Plain-text email — no HTML template needed for a short notification.
    sendEmail({
      to: user.email,
      subject: `✅ "${asset.title}" is now available - BIG Shelf`,
      text: [
        `Hi ${user.firstName ?? "there"},`,
        "",
        `Good news — "${asset.title}" is now available to reserve. You asked to be notified when it freed up.`,
        "",
        `Reserve it here: ${reserveUrl}`,
        "",
        "Equipment is first-come, first-served, so grab it soon.",
        "",
        "— The BIG Shelf team",
      ].join("\n"),
    });
    notified++;
  }

  return notified;
}
