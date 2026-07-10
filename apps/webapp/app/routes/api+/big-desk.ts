/**
 * BIG Desk API — `/api/big-desk`
 *
 * Scan-driven front-desk equipment moves, powering the scanner's
 * "Check in equipment" / "Check out equipment" quick actions: staff sweep
 * labels at the desk, and this endpoint figures out WHICH booking each asset
 * belongs to and runs the corresponding upstream partial check-in/check-out —
 * so notes, events, status changes, and partial-tracking all stay exactly as
 * if it were done from the booking page.
 *
 * - `intent=check-in` (booking:checkin): each asset must be CHECKED_OUT; its
 *   ONGOING/OVERDUE booking is found (skipping bookings it was already
 *   partially checked into), assets are grouped per booking, and
 *   `partialCheckinBooking` runs per group.
 * - `intent=check-out` (booking:checkout): each asset must not already be
 *   out; its RESERVED booking with the earliest start (falling back to an
 *   ONGOING booking for late pickups) is chosen, then
 *   `partialCheckoutBooking` runs per group.
 *
 * Per-asset problems (no booking found, kit member, wrong status) come back
 * as `failures` so the drawer can tell staff exactly what to do instead —
 * one bad scan never blocks the rest of the pile.
 *
 * BIG-only additive route; composes upstream booking services.
 *
 * @see {@link file://./../../components/scanner/drawer/uses/big-desk-drawers.tsx}
 */
import { BookingStatus } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { z } from "zod";
import { db } from "~/database/db.server";
import {
  getPartiallyCheckedInAssetIds,
  partialCheckinBooking,
  partialCheckoutBooking,
} from "~/modules/booking/service.server";
import { getClientHint } from "~/utils/client-hints";
import { makeShelfError } from "~/utils/error";
import { error, parseData, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/** The drawer posts an intent + the scanned asset ids. */
const DeskSchema = z.object({
  intent: z.enum(["check-in", "check-out"]),
  assetIds: z.array(z.string().min(1)).min(1),
});

/** One booking that was acted on. */
export type DeskResult = {
  bookingId: string;
  bookingName: string;
  assetCount: number;
};

/** One asset that couldn't be processed, with the reason staff sees. */
export type DeskFailure = {
  assetId: string;
  title: string;
  reason: string;
};

/** The JSON this endpoint returns on success. */
export type DeskResponse = {
  ok: true;
  results: DeskResult[];
  failures: DeskFailure[];
};

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const formData = await request.formData();
    const { intent, assetIds: rawAssetIds } = parseData(formData, DeskSchema, {
      shouldBeCaptured: false,
      additionalData: { userId },
    });
    const assetIds = [...new Set(rawAssetIds)];

    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action:
        intent === "check-in"
          ? PermissionAction.checkin
          : PermissionAction.checkout,
    });

    // Org-scoped asset lookup; anything not found is simply skipped from the
    // grouping and reported as a failure below.
    const assets = await db.asset.findMany({
      where: { id: { in: assetIds }, organizationId },
      select: { id: true, title: true, status: true, kitId: true },
    });
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));

    const failures: DeskFailure[] = [];
    for (const id of assetIds) {
      if (!assetById.has(id)) {
        failures.push({
          assetId: id,
          title: "Unknown asset",
          reason: "This item doesn't exist in this workspace.",
        });
      }
    }

    /** Assets that pass the per-intent status/kit screens. */
    const eligible = assets.filter((asset) => {
      if (asset.kitId) {
        failures.push({
          assetId: asset.id,
          title: asset.title,
          reason:
            "This item is part of a kit — handle it from its booking page.",
        });
        return false;
      }
      if (intent === "check-in" && String(asset.status) !== "CHECKED_OUT") {
        failures.push({
          assetId: asset.id,
          title: asset.title,
          reason: "This item isn't checked out.",
        });
        return false;
      }
      if (intent === "check-out" && String(asset.status) === "CHECKED_OUT") {
        failures.push({
          assetId: asset.id,
          title: asset.title,
          reason: "This item is already checked out.",
        });
        return false;
      }
      return true;
    });

    const eligibleIds = eligible.map((asset) => asset.id);
    const results: DeskResult[] = [];

    if (eligibleIds.length > 0) {
      // Candidate bookings holding any of the eligible assets.
      const candidateStatuses =
        intent === "check-in"
          ? [BookingStatus.ONGOING, BookingStatus.OVERDUE]
          : [BookingStatus.RESERVED, BookingStatus.ONGOING];

      const bookings = await db.booking.findMany({
        where: {
          organizationId,
          status: { in: candidateStatuses },
          assets: { some: { id: { in: eligibleIds } } },
        },
        select: {
          id: true,
          name: true,
          status: true,
          from: true,
          assets: {
            where: { id: { in: eligibleIds } },
            select: { id: true },
          },
        },
        orderBy: { from: "asc" },
      });

      // For check-in, an asset already partially checked back into a booking
      // must not be "checked in" there again.
      const alreadyCheckedIn = new Map<string, Set<string>>();
      if (intent === "check-in") {
        for (const booking of bookings) {
          alreadyCheckedIn.set(
            booking.id,
            new Set(await getPartiallyCheckedInAssetIds(booking.id))
          );
        }
      }

      // Choose one booking per asset: earliest-starting RESERVED first for
      // check-out (that's the reservation being picked up), else earliest
      // candidate. `bookings` is already sorted by `from`.
      const groups = new Map<string, string[]>();
      for (const asset of eligible) {
        const candidates = bookings.filter(
          (booking) =>
            booking.assets.some((a) => a.id === asset.id) &&
            !alreadyCheckedIn.get(booking.id)?.has(asset.id)
        );
        const chosen =
          intent === "check-out"
            ? candidates.find(
                (booking) => booking.status === BookingStatus.RESERVED
              ) ?? candidates[0]
            : candidates[0];

        if (!chosen) {
          failures.push({
            assetId: asset.id,
            title: asset.title,
            reason:
              intent === "check-in"
                ? "No active booking found holding this item."
                : "No reservation found for this item — use “Make a reservation” first.",
          });
          continue;
        }
        groups.set(chosen.id, [...(groups.get(chosen.id) ?? []), asset.id]);
      }

      // Run the upstream partial move per booking; one failed booking never
      // blocks the others.
      const hints = getClientHint(request);
      for (const [bookingId, groupAssetIds] of groups) {
        const booking = bookings.find((b) => b.id === bookingId);
        try {
          if (intent === "check-in") {
            await partialCheckinBooking({
              id: bookingId,
              organizationId,
              assetIds: groupAssetIds,
              userId,
              hints,
            });
          } else {
            await partialCheckoutBooking({
              id: bookingId,
              organizationId,
              assetIds: groupAssetIds,
              userId,
              hints,
            });
          }
          results.push({
            bookingId,
            bookingName: booking?.name ?? "Booking",
            assetCount: groupAssetIds.length,
          });
        } catch (cause) {
          const reason = makeShelfError(cause, { bookingId }, false);
          for (const assetId of groupAssetIds) {
            failures.push({
              assetId,
              title: assetById.get(assetId)?.title ?? "Item",
              reason: `${booking?.name ?? "Booking"}: ${reason.message}`,
            });
          }
        }
      }
    }

    return data(
      payload({ ok: true as const, results, failures } satisfies DeskResponse)
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
