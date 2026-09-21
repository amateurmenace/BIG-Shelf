/**
 * Member directory service
 *
 * BIG: lets staff reserve equipment and rooms for ANY member of the
 * organisation, not just the handful who happen to have logged in.
 *
 * The problem this solves: a booking's custodian must be a `TeamMember`, and a
 * `TeamMember` row only exists once someone has been invited or has signed in.
 * BIG's actual membership lives in Neon CRM and is mirrored into
 * `NeonAllowlistMember` — 113 people, of whom only one had ever logged in. So
 * the "Reserved for" picker could offer about a dozen staff and essentially no
 * members, which made booking on a member's behalf impossible for exactly the
 * people it was built for.
 *
 * The picker therefore searches both sets, and a Neon-only person is turned
 * into a real `TeamMember` lazily — at the moment someone is actually reserved
 * for, never in bulk. Creating 113 rows up front would fill the Team settings
 * page with people who have no relationship to Shelf.
 *
 * A materialised row is a non-registered member (`userId: null`) unless a
 * matching account already exists, in which case it is linked. When that person
 * later signs up, shelf's invite-acceptance flow links their new account to the
 * same row, so their booking history follows them.
 *
 * @see {@link file://./shared.ts} — the client-safe id prefix
 * @see {@link file://./../big-neon-sync/service.server.ts} — how the allowlist is filled
 * @see {@link file://./../../routes/api+/model-filters.ts} — the picker's search endpoint
 */
import type { Organization, User } from "@prisma/client";
import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";
import {
  NEON_CUSTODIAN_PREFIX,
  isNeonCustodianId,
  neonAllowlistIdFromCustodianId,
} from "./shared";

const label = "Team Member" as const;

/** One Neon-only person, shaped like a picker option. */
export type DirectoryOption = {
  /** `neon:<allowlistId>` — not a Shelf id. */
  id: string;
  name: string;
  email: string;
};

/** Builds a display name, falling back to the email when Neon has no name. */
function displayName(row: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  const full = [row.firstName, row.lastName]
    .filter((part) => part && part.trim())
    .join(" ")
    .trim();
  return full || row.email;
}

/**
 * Finds Neon members who have no `TeamMember` row in this organization.
 *
 * Anyone who already has a row is excluded, because they are returned by the
 * ordinary team-member query and would otherwise appear twice in the picker.
 *
 * @param args.organizationId - The caller's organization.
 * @param args.query - Free text matched against first name, last name and
 *   email. An empty query returns the first `take` alphabetically, so the
 *   picker shows something before the user types.
 * @param args.take - Maximum rows to return.
 * @returns Picker options carrying `neon:`-prefixed ids.
 */
export async function searchDirectoryMembers({
  organizationId,
  query,
  take = 25,
}: {
  organizationId: Organization["id"];
  query?: string | null;
  take?: number;
}): Promise<DirectoryOption[]> {
  try {
    const trimmed = (query ?? "").trim();

    /**
     * `NeonAllowlistMember` is deliberately global — it mirrors Neon CRM,
     * which is BIG's single membership source, and carries no organizationId
     * column. Org scoping is applied where it matters: the exclusion below and
     * any row we create are both scoped to the caller's organization.
     */
    const candidates = await db.neonAllowlistMember.findMany({
      where: trimmed
        ? {
            OR: [
              { firstName: { contains: trimmed, mode: "insensitive" } },
              { lastName: { contains: trimmed, mode: "insensitive" } },
              { email: { contains: trimmed, mode: "insensitive" } },
            ],
          }
        : undefined,
      select: { id: true, email: true, firstName: true, lastName: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      // Over-fetch: some candidates are dropped below for already having a
      // TeamMember row, and we still want a full page after that filtering.
      take: take * 3,
    });

    if (candidates.length === 0) return [];

    const emails = candidates.map((row) => row.email.toLowerCase());

    // Everyone in this org who already has a TeamMember row, by email.
    const existing = await db.teamMember.findMany({
      where: {
        organizationId,
        deletedAt: null,
        user: { email: { in: emails } },
      },
      select: { user: { select: { email: true } } },
    });
    const taken = new Set(
      existing
        .map((row) => row.user?.email?.toLowerCase())
        .filter((email): email is string => Boolean(email))
    );

    return candidates
      .filter((row) => !taken.has(row.email.toLowerCase()))
      .slice(0, take)
      .map((row) => ({
        id: `${NEON_CUSTODIAN_PREFIX}${row.id}`,
        name: displayName(row),
        email: row.email,
      }));
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Could not search the member directory.",
      additionalData: { organizationId },
      label,
    });
  }
}

/**
 * Turns a custodian id from a reservation form into a real `TeamMember` id.
 *
 * Pass-through for an ordinary Shelf id, after proving it belongs to the
 * caller's organization. For a `neon:` id it finds or creates the member's
 * `TeamMember` row and returns that instead.
 *
 * Idempotent: reserving twice for the same Neon member reuses the first row
 * rather than creating a duplicate.
 *
 * @param args.organizationId - The caller's organization; every read and write
 *   here is scoped to it.
 * @param args.custodianId - Either a `TeamMember` id or `neon:<allowlistId>`.
 * @returns The resolved team member's id and userId (null for a
 *   non-registered member).
 * @throws {ShelfError} 404 when the id matches nothing this organization can
 *   reserve for.
 * @see .claude/rules/org-scope-user-supplied-ids.md
 */
export async function resolveReservationCustodian({
  organizationId,
  custodianId,
}: {
  organizationId: Organization["id"];
  custodianId: string;
}): Promise<{ id: string; userId: User["id"] | null; name: string }> {
  if (!isNeonCustodianId(custodianId)) {
    const teamMember = await db.teamMember.findFirst({
      where: { id: custodianId, organizationId, deletedAt: null },
      select: { id: true, userId: true, name: true },
    });

    if (!teamMember) {
      throw new ShelfError({
        cause: null,
        title: "Member not found",
        message:
          "The person this reservation is for could not be found in this workspace.",
        additionalData: { organizationId, custodianId },
        status: 404,
        shouldBeCaptured: false,
        label,
      });
    }

    return teamMember;
  }

  const allowlistId = neonAllowlistIdFromCustodianId(custodianId);
  const member = await db.neonAllowlistMember.findUnique({
    where: { id: allowlistId },
    select: { id: true, email: true, firstName: true, lastName: true },
  });

  if (!member) {
    throw new ShelfError({
      cause: null,
      title: "Member not found",
      message:
        "That member is no longer in the directory. They may have been removed from Neon since this page loaded.",
      additionalData: { organizationId, custodianId },
      status: 404,
      shouldBeCaptured: false,
      label,
    });
  }

  const email = member.email.toLowerCase();

  // An account may exist even though no TeamMember row does — e.g. they signed
  // up but were never added to this workspace. Link it rather than creating an
  // orphan NRM that would split their history in two.
  const account = await db.user.findFirst({
    where: { email },
    select: { id: true },
  });

  // Reuse an existing row if one appeared since the picker loaded (two staff
  // reserving for the same person at once, or a mid-session Neon sync).
  const existing = await db.teamMember.findFirst({
    where: {
      organizationId,
      deletedAt: null,
      ...(account
        ? { userId: account.id }
        : { name: displayName(member), userId: null }),
    },
    select: { id: true, userId: true, name: true },
  });

  if (existing) return existing;

  return db.teamMember.create({
    data: {
      name: displayName(member),
      organizationId,
      ...(account ? { userId: account.id } : {}),
    },
    select: { id: true, userId: true, name: true },
  });
}
