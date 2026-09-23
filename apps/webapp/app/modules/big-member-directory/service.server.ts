/**
 * Member directory service
 *
 * BIG: lets staff reserve equipment and rooms for ANYONE in the organisation —
 * staff, members with accounts, and the Neon members who have never logged in.
 *
 * Why this exists: a booking's custodian must be a `TeamMember`, and that row
 * only exists once someone has been invited or has signed in. BIG's actual
 * membership lives in Neon CRM (mirrored into `NeonAllowlistMember`, ~105
 * people), and almost none of them have ever logged in. A picker that only
 * reads `TeamMember` therefore offers staff and nobody else.
 *
 * So the picker is fed the COMPLETE list from {@link listReservablePeople} —
 * every team member plus every Neon member not already among them — and
 * searches it in the browser. The population is small (low hundreds), so
 * loading it whole is cheaper and far more reliable than server-side paging.
 *
 * A Neon-only person is turned into a real `TeamMember` lazily, at the moment
 * someone is actually reserved for ({@link resolveReservationCustodian}), and
 * a `MemberDirectoryLink` records which email it was created for. Creating
 * ~105 rows up front would fill Team settings with people who have no
 * relationship to Shelf.
 *
 * @see {@link file://./shared.ts} — id format, person type, client-side search
 * @see {@link file://./../../routes/api+/big-reservable-people.ts} — the endpoint
 * @see {@link file://./../../components/big/member-picker.tsx} — the picker
 */
import { Prisma } from "@prisma/client";
import type { Organization, User } from "@prisma/client";
import { db } from "~/database/db.server";
import type { AdditionalData } from "~/utils/error";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { resolveUserDisplayName } from "~/utils/user";
import type { ReservablePerson } from "./shared";
import {
  emailFromNeonCustodianId,
  isNeonCustodianId,
  neonCustodianIdForEmail,
} from "./shared";

const label = "Team Member" as const;

/** A Neon member's display name, falling back to their email. */
function directoryName(row: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  const full = [row.firstName, row.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return full || row.email;
}

/**
 * Lists everyone staff can reserve for in this organization — one row per
 * person, sorted by name.
 *
 * Sources, and which wins when two describe the same person (same email):
 * 1. a team member with an account (staff, and members who have signed in);
 * 2. an account-less team member created for a Neon member earlier;
 * 3. a Neon member with no record yet (id `neon:<email>`).
 *
 * Team members that have never had an email (placeholder records such as the
 * organization itself) are listed once each.
 *
 * @param args.organizationId - The caller's organization; team-member and link
 *   reads are scoped to it. The Neon allowlist has no organization column — it
 *   mirrors Neon, BIG's single membership source.
 * @returns Every reservable person.
 * @throws {ShelfError} When the database read fails.
 */
export async function listReservablePeople({
  organizationId,
}: {
  organizationId: Organization["id"];
}): Promise<ReservablePerson[]> {
  try {
    const [teamMembers, directory] = await Promise.all([
      db.teamMember.findMany({
        where: { organizationId, deletedAt: null },
        select: {
          id: true,
          name: true,
          userId: true,
          user: {
            select: {
              email: true,
              firstName: true,
              lastName: true,
              displayName: true,
            },
          },
          directoryLink: { select: { email: true } },
        },
      }),
      db.neonAllowlistMember.findMany({
        select: { email: true, firstName: true, lastName: true },
      }),
    ]);

    const byEmail = new Map<string, ReservablePerson>();
    const withoutEmail: ReservablePerson[] = [];

    for (const member of teamMembers) {
      const email =
        member.user?.email?.toLowerCase() ??
        member.directoryLink?.email ??
        null;
      const person: ReservablePerson = {
        id: member.id,
        // An account's own name beats the record's, which can be stale.
        name:
          (member.user && resolveUserDisplayName(member.user)) || member.name,
        email,
        userId: member.userId,
        hasAccount: Boolean(member.userId),
      };

      if (!email) {
        withoutEmail.push(person);
        continue;
      }

      // Rule 1 beats rule 2: someone who signed up after being reserved for
      // has both an account record and the older account-less one.
      const existing = byEmail.get(email);
      if (!existing || (!existing.hasAccount && person.hasAccount)) {
        byEmail.set(email, person);
      }
    }

    for (const row of directory) {
      const email = row.email.toLowerCase();
      if (byEmail.has(email)) continue;

      byEmail.set(email, {
        id: neonCustodianIdForEmail(email),
        name: directoryName(row),
        email,
        userId: null,
        hasAccount: false,
      });
    }

    return [...byEmail.values(), ...withoutEmail].sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        (a.email ?? "").localeCompare(b.email ?? "")
    );
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Could not load the member list.",
      additionalData: { organizationId },
      label,
    });
  }
}

/** What a reservation form's custodian resolves to. */
type ResolvedCustodian = {
  id: string;
  userId: User["id"] | null;
  name: string;
};

/** A 404 for a pick that matches nothing this organization can reserve for. */
function memberNotFound(message: string, additionalData: AdditionalData) {
  return new ShelfError({
    cause: null,
    title: "Member not found",
    message,
    additionalData,
    status: 404,
    shouldBeCaptured: false,
    label,
  });
}

/**
 * Turns the custodian id a reservation form submitted into a real
 * `TeamMember`, creating one for a Neon member who has no record yet.
 *
 * - An ordinary id is looked up scoped to the caller's organization, so a
 *   forged id from another organization is a 404, never a cross-org booking.
 * - A `neon:<email>` id must be a CURRENT Neon member. It reuses their
 *   existing record when there is one — their account's, or the account-less
 *   one made the first time they were reserved for — and otherwise creates an
 *   account-less record plus the link that ties it to their email.
 *
 * Idempotent and race-safe: two staff reserving for the same person at once
 * end up with one record.
 *
 * @param args.organizationId - The caller's organization.
 * @param args.custodianId - A `TeamMember` id, or `neon:<email>`.
 * @param args.allowDirectory - Whether the caller may reserve for someone
 *   without a record. Must be false for members/self-service, who can only
 *   book for themselves — otherwise a crafted form could make Shelf create
 *   records for arbitrary Neon members before the route's own-booking check
 *   rejects the request.
 * @returns The team member to put on the booking.
 * @throws {ShelfError} 404 when nothing matches; 403 for a directory pick
 *   when `allowDirectory` is false.
 * @see .claude/rules/org-scope-user-supplied-ids.md
 */
export async function resolveReservationCustodian({
  organizationId,
  custodianId,
  allowDirectory,
}: {
  organizationId: Organization["id"];
  custodianId: string;
  allowDirectory: boolean;
}): Promise<ResolvedCustodian> {
  if (!isNeonCustodianId(custodianId)) {
    const teamMember = await db.teamMember.findFirst({
      where: { id: custodianId, organizationId, deletedAt: null },
      select: { id: true, userId: true, name: true },
    });

    if (!teamMember) {
      throw memberNotFound(
        "The person this reservation is for could not be found in this workspace.",
        { organizationId, custodianId }
      );
    }

    return teamMember;
  }

  if (!allowDirectory) {
    throw new ShelfError({
      cause: null,
      title: "Not allowed",
      message: "You can only make reservations for yourself.",
      additionalData: { organizationId, custodianId },
      status: 403,
      shouldBeCaptured: false,
      label,
    });
  }

  const email = emailFromNeonCustodianId(custodianId);
  const member = email.includes("@")
    ? await db.neonAllowlistMember.findUnique({
        where: { email },
        select: { email: true, firstName: true, lastName: true },
      })
    : null;

  if (!member) {
    throw memberNotFound(
      "That member is no longer in the directory — their Neon membership may have lapsed since this page loaded. Reload the page and pick them again.",
      { organizationId, custodianId }
    );
  }

  const existing = await findExistingRecord({ organizationId, email });
  if (existing) return existing;

  try {
    return await db.$transaction(async (tx) => {
      const teamMember = await tx.teamMember.create({
        data: { name: directoryName(member), organizationId },
        select: { id: true, userId: true, name: true },
      });

      // Upsert, not create: a link can outlive its record's soft-deletion
      // (staff removed the person from Team). Re-point it at the new record.
      await tx.memberDirectoryLink.upsert({
        where: { organizationId_email: { organizationId, email } },
        create: { organizationId, email, teamMemberId: teamMember.id },
        update: { teamMemberId: teamMember.id },
      });

      return teamMember;
    });
  } catch (cause) {
    // Lost a race with a concurrent reservation for the same person: the
    // unique (organizationId, email) link rolled our transaction back, so
    // return the record the winner created.
    if (
      cause instanceof Prisma.PrismaClientKnownRequestError &&
      cause.code === "P2002"
    ) {
      const winner = await findExistingRecord({ organizationId, email });
      if (winner) return winner;
    }

    throw new ShelfError({
      cause,
      message: "Could not create a record for this member.",
      additionalData: { organizationId, custodianId },
      label,
    });
  }
}

/**
 * Finds the live record already representing this email in the organization:
 * their account's team member first, then an account-less one linked to them.
 */
async function findExistingRecord({
  organizationId,
  email,
}: {
  organizationId: Organization["id"];
  email: string;
}): Promise<ResolvedCustodian | null> {
  const withAccount = await db.teamMember.findFirst({
    where: {
      organizationId,
      deletedAt: null,
      user: { email: { equals: email, mode: "insensitive" } },
    },
    select: { id: true, userId: true, name: true },
  });
  if (withAccount) return withAccount;

  const link = await db.memberDirectoryLink.findUnique({
    where: { organizationId_email: { organizationId, email } },
    select: {
      teamMember: {
        select: { id: true, userId: true, name: true, deletedAt: true },
      },
    },
  });
  if (link && !link.teamMember.deletedAt) {
    const { deletedAt: _deletedAt, ...teamMember } = link.teamMember;
    return teamMember;
  }

  return null;
}

/** What {@link ensureMemberRecord} did, for callers that log or test it. */
export type MemberRecordOutcome =
  /** They already had a record; nothing changed. */
  | "existing"
  /** They took over the account-less record staff had been booking on. */
  | "adopted"
  /** Nobody had booked for them; a fresh record was made. */
  | "created";

/**
 * Makes sure a person with an account has their team-member record in this
 * organization — taking over the account-less one staff created for them, so
 * reservations made on their behalf before they signed up are theirs now.
 *
 * Why this exists: every BIG member self-signup path (Neon sign-in,
 * Google/Microsoft, email) attached the account to BIG but never created its
 * `TeamMember`; only invites did. A member who signed up on their own was then
 * stopped by the portal ("Your account isn't linked to a team member yet…")
 * with no way for staff to fix it. And someone reserved for from the Neon
 * directory before signing up had their bookings on an account-less record
 * their new account never saw.
 *
 * In order:
 * 1. They already have a live record here → returned unchanged.
 * 2. Staff reserved for them before they had an account → that record becomes
 *    theirs: it is linked to the account, and its bookings gain the account as
 *    custodian, so they appear under the member's reservations. Matched by the
 *    account's email, or by any Neon email on the same Neon account (members
 *    may sign up with a secondary address).
 * 3. Otherwise → a new record linked to the account.
 *
 * Runs under a per-person advisory lock: two simultaneous first logins (a
 * known signup race here) would otherwise each create a record.
 *
 * @param args.organizationId - The organization they belong to.
 * @param args.userId - Their account.
 * @returns Their record, and which of the three paths was taken.
 * @throws {ShelfError} When the account does not exist or the write fails.
 */
export async function ensureMemberRecord({
  organizationId,
  userId,
}: {
  organizationId: Organization["id"];
  userId: User["id"];
}): Promise<
  ResolvedCustodian & { outcome: MemberRecordOutcome; movedBookings: number }
> {
  const recordSelect = { id: true, userId: true, name: true } as const;

  try {
    return await db.$transaction(async (tx) => {
      // Serialise concurrent first logins for the same person. Released
      // automatically when the transaction ends.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-record:${organizationId}:${userId}`}))`;

      const existing = await tx.teamMember.findFirst({
        where: { organizationId, userId, deletedAt: null },
        select: recordSelect,
      });
      if (existing) {
        return { ...existing, outcome: "existing" as const, movedBookings: 0 };
      }

      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          email: true,
          firstName: true,
          lastName: true,
          displayName: true,
          neonAccountId: true,
        },
      });
      const name = resolveUserDisplayName(user) || user.email;

      // Every email this person is known by in Neon: the one they signed up
      // with, plus any other address on the same Neon account.
      const emails = new Set([user.email.toLowerCase()]);
      if (user.neonAccountId) {
        const sameAccount = await tx.neonAllowlistMember.findMany({
          where: { neonAccountId: user.neonAccountId },
          select: { email: true },
        });
        for (const row of sameAccount) emails.add(row.email.toLowerCase());
      }

      const links = await tx.memberDirectoryLink.findMany({
        where: { organizationId, email: { in: [...emails] } },
        select: {
          email: true,
          teamMember: {
            select: { id: true, userId: true, deletedAt: true },
          },
        },
      });
      // Prefer the record made under the email they signed up with. Never
      // take a record that already belongs to another account.
      const adoptable = links
        .filter((link) => !link.teamMember.deletedAt && !link.teamMember.userId)
        .sort(
          (a, b) =>
            Number(b.email === user.email.toLowerCase()) -
            Number(a.email === user.email.toLowerCase())
        )[0];

      if (adoptable) {
        const record = await tx.teamMember.update({
          // Scoped to the organization as well as the id, so a record could
          // never be claimed across workspaces even if a link were wrong.
          where: { id: adoptable.teamMember.id, organizationId },
          data: { userId, name },
          select: recordSelect,
        });
        // The record already IS the custodian of these bookings; this makes
        // the account the custodian too, so they show under the member's own
        // reservations (which are looked up by account).
        const { count } = await tx.booking.updateMany({
          where: {
            organizationId,
            custodianTeamMemberId: record.id,
            custodianUserId: null,
          },
          data: { custodianUserId: userId },
        });
        return { ...record, outcome: "adopted" as const, movedBookings: count };
      }

      const created = await tx.teamMember.create({
        data: { name, organizationId, userId },
        select: recordSelect,
      });
      return { ...created, outcome: "created" as const, movedBookings: 0 };
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Could not set up this member's record.",
      additionalData: { organizationId, userId },
      label,
    });
  }
}

/**
 * {@link ensureMemberRecord} for sign-in paths: never throws.
 *
 * Signing in must not fail because this step did — a member locked out of
 * their account over a missing team-member row is worse than the row being
 * created a moment later. On failure it logs loudly; the member portal calls
 * {@link ensureMemberRecord} itself before anything needs the record, so the
 * work is simply redone there.
 *
 * @param args.organizationId - The organization they just joined or entered.
 * @param args.userId - Their account.
 */
export async function ensureMemberRecordBestEffort(args: {
  organizationId: Organization["id"];
  userId: User["id"];
}): Promise<void> {
  try {
    await ensureMemberRecord(args);
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        message:
          "Could not set up a member's record at sign-in; the member portal will retry on first use.",
        additionalData: args,
        label,
      })
    );
  }
}
