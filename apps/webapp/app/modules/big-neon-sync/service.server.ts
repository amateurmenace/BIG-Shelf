/**
 * BIG Neon member sync — server service
 *
 * The admin "Sync now" bulk pull: fetches every ACTIVE member from Neon CRM and
 * provisions/refreshes their Shelf login (the MEMBER role in BIG's member
 * workspace), so members exist in Shelf without each having to self-sign-up.
 * Neon is the source of truth.
 *
 * `previewNeonMemberSync` is READ-ONLY — it reports what a sync WOULD do so an
 * admin can see the impact first. `syncNeonMembers` performs the provisioning.
 * Both share one classification pass. `syncNeonMembers` is idempotent (safe to
 * re-run) and is structured so a future scheduled job can call it directly.
 *
 * @see {@link file://./../../integrations/neon-crm/client.server.ts}
 * @see {@link file://./../big-neon-auth/service.server.ts} — the per-login equivalent
 * @see {@link file://./../../routes/_layout+/settings.member-sync.tsx}
 */
import { randomUUID } from "node:crypto";
import { OrganizationRoles } from "@prisma/client";
import { db } from "~/database/db.server";
import {
  isNeonApiConfigured,
  listActiveNeonMembers,
} from "~/integrations/neon-crm/client.server";
import { createUserOrAttachOrg } from "~/modules/user/service.server";
import { NEON_MEMBER_ORG_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";

const label = "Neon Sync" as const;

/** Cap on how many per-member errors we surface back to the admin. */
const MAX_REPORTED_ERRORS = 25;

/**
 * Aggregate outcome of a sync (or a preview, where the same fields describe what
 * WOULD happen).
 */
export type NeonSyncResult = {
  /** Active members Neon returned. */
  totalActive: number;
  /** New Shelf users provisioned. */
  created: number;
  /** Existing users given the MEMBER role in the workspace. */
  attached: number;
  /** Already members — nothing to do (Neon id re-stamped if missing). */
  skipped: number;
  /** Members that could not be provisioned. */
  failed: number;
  /** Whether these numbers are a dry-run projection (preview) or actual. */
  previewOnly: boolean;
  /** Up to {@link MAX_REPORTED_ERRORS} per-member failures. */
  errors: { email: string; message: string }[];
};

/** Prior state of a Shelf user relative to the member workspace. */
type PriorState = { alreadyMember: boolean; hasNeonId: boolean };

/**
 * Resolves the member workspace id (the org members are synced into) or throws
 * a clear 503 when it isn't configured.
 */
function requireMemberOrgId(): string {
  if (!NEON_MEMBER_ORG_ID) {
    throw new ShelfError({
      cause: null,
      title: "Member workspace not configured",
      message:
        "NEON_MEMBER_ORG_ID is not set, so there is no workspace to sync members into.",
      label,
      status: 503,
      shouldBeCaptured: false,
    });
  }
  return NEON_MEMBER_ORG_ID;
}

/** Throws a 503 when the Neon REST API credentials are not configured. */
function assertNeonConfigured(): void {
  if (!isNeonApiConfigured()) {
    throw new ShelfError({
      cause: null,
      title: "Neon is not configured",
      message:
        "The Neon API credentials (NEON_ORG_ID + NEON_API_KEY) are not set for this site, so members can't be synced.",
      label,
      status: 503,
      shouldBeCaptured: false,
    });
  }
}

/**
 * Batch-loads the prior state of many emails in ONE query: whether each already
 * holds the MEMBER role in the workspace and whether their Neon id is stamped.
 *
 * @param emails - Lowercased emails to look up
 * @param organizationId - The member workspace
 * @returns Map keyed by lowercased email → {@link PriorState} (absent = no user)
 */
async function loadPriorStateByEmail(
  emails: string[],
  organizationId: string
): Promise<Map<string, PriorState>> {
  const users = await db.user.findMany({
    where: { email: { in: emails } },
    select: {
      email: true,
      neonAccountId: true,
      userOrganizations: {
        where: { organizationId },
        select: { roles: true },
      },
    },
  });

  return new Map(
    users.map((user) => [
      user.email.toLowerCase(),
      {
        alreadyMember: (user.userOrganizations[0]?.roles ?? []).includes(
          OrganizationRoles.MEMBER
        ),
        hasNeonId: Boolean(user.neonAccountId),
      },
    ])
  );
}

/** Best-effort: stamp a user's Neon account id if it isn't already set. */
async function stampNeonId(
  email: string,
  neonAccountId: string,
  alreadyStamped: boolean
): Promise<void> {
  if (alreadyStamped) {
    return;
  }
  // Swallow — a unique-collision or race must not fail the whole member; the
  // next sync/login reconciles it (mirrors linkNeonAccountByEmail).
  await db.user
    .update({ where: { email }, data: { neonAccountId } })
    .catch(() => undefined);
}

/**
 * Fetches active Neon members and classifies each against Shelf's current state.
 * Shared by preview + sync so both agree on the numbers.
 *
 * @returns The member list, the normalized emails, and the prior-state map
 */
async function loadMembersAndPriorState() {
  assertNeonConfigured();
  const organizationId = requireMemberOrgId();

  const members = await listActiveNeonMembers();
  const emails = members
    .map((member) => member.email?.trim().toLowerCase())
    .filter((email): email is string => Boolean(email));
  const priorByEmail = await loadPriorStateByEmail(emails, organizationId);

  return { members, organizationId, priorByEmail };
}

/**
 * READ-ONLY preview: reports how many members would be created / attached /
 * skipped without writing anything. Safe to run anytime.
 *
 * @returns The projected {@link NeonSyncResult} (`previewOnly: true`)
 * @throws {ShelfError} If Neon or the member workspace isn't configured
 */
export async function previewNeonMemberSync(): Promise<NeonSyncResult> {
  const { members, priorByEmail } = await loadMembersAndPriorState();

  const result: NeonSyncResult = {
    totalActive: members.length,
    created: 0,
    attached: 0,
    skipped: 0,
    failed: 0,
    previewOnly: true,
    errors: [],
  };

  for (const member of members) {
    const email = member.email?.trim().toLowerCase();
    if (!email) {
      result.failed++;
      continue;
    }
    const prior = priorByEmail.get(email);
    if (!prior) {
      result.created++;
    } else if (!prior.alreadyMember) {
      result.attached++;
    } else {
      result.skipped++;
    }
  }

  return result;
}

/**
 * Provisions/refreshes every active Neon member as a MEMBER in the workspace.
 * Idempotent: users already holding MEMBER are left untouched (only their Neon
 * id is back-filled), so re-running never duplicates roles.
 *
 * @returns The actual {@link NeonSyncResult} (`previewOnly: false`)
 * @throws {ShelfError} If Neon or the member workspace isn't configured
 */
export async function syncNeonMembers(): Promise<NeonSyncResult> {
  const { members, organizationId, priorByEmail } =
    await loadMembersAndPriorState();

  const result: NeonSyncResult = {
    totalActive: members.length,
    created: 0,
    attached: 0,
    skipped: 0,
    failed: 0,
    previewOnly: false,
    errors: [],
  };

  for (const member of members) {
    const email = member.email?.trim().toLowerCase();
    if (!email) {
      result.failed++;
      continue;
    }

    try {
      const prior = priorByEmail.get(email);

      if (prior?.alreadyMember) {
        // Already a member — only back-fill the Neon id if it's missing.
        await stampNeonId(email, member.neonAccountId, prior.hasNeonId);
        result.skipped++;
        continue;
      }

      // New user OR an existing user without the MEMBER role: create/attach.
      // (Skipping this when alreadyMember avoids the roles `push` duplication.)
      await createUserOrAttachOrg({
        email,
        organizationId,
        roles: [OrganizationRoles.MEMBER],
        password: `${randomUUID()}${randomUUID()}`,
        firstName: member.firstName,
        lastName: member.lastName ?? undefined,
        createdWithInvite: true,
      });
      await stampNeonId(email, member.neonAccountId, prior?.hasNeonId ?? false);

      if (prior) {
        result.attached++;
      } else {
        result.created++;
      }
    } catch (cause) {
      result.failed++;
      if (result.errors.length < MAX_REPORTED_ERRORS) {
        result.errors.push({
          email,
          message: cause instanceof Error ? cause.message : "Unknown error",
        });
      }
    }
  }

  return result;
}
