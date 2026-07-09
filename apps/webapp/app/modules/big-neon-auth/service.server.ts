/**
 * BIG "Log in with Neon" — provisioning + session minting (server-only)
 *
 * Turns a Neon-verified constituent into a signed-in BIG Shelf member:
 *  1. Require an ACTIVE Neon membership (already checked upstream, re-asserted).
 *  2. Find-or-create the shelf `User` for their email, attached to BIG's Team
 *     workspace with the `MEMBER` role, and stamp their `neonAccountId`.
 *  3. Mint a fresh Supabase session WITHOUT a password (admin `generateLink`
 *     magiclink → `verifyOtp`) — the same passwordless mint shelf uses for
 *     mobile SSO. Neon owns the credential; we own the session.
 *
 * The OAuth `state` helpers below give the login round-trip CSRF protection: we
 * issue a short-lived signed token when starting the flow and verify it on the
 * callback, so a forged callback can't drive a login.
 *
 * @see {@link file://./../../integrations/neon-crm/client.server.ts}
 * @see {@link file://./../auth/mobile-sso.server.ts} — the mint pattern mirrored here
 * @see {@link file://./../../routes/_auth+/neon.callback.tsx}
 */
import { randomUUID } from "node:crypto";
import { OrganizationRoles } from "@prisma/client";
import jwt from "jsonwebtoken";
import type { AuthSession } from "@server/session";
import { db } from "~/database/db.server";
import {
  isNeonApiConfigured,
  resolveNeonMemberByEmail,
  type NeonMember,
} from "~/integrations/neon-crm/client.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import { mapAuthSession } from "~/modules/auth/mappers.server";
import { createUserOrAttachOrg } from "~/modules/user/service.server";
import { NEON_MEMBER_ORG_ID, SESSION_SECRET } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

const label = "Neon Auth" as const;

/**
 * The member-facing message shown wherever the active-Neon-membership check
 * fails — at social/email signup and when a member tries to reserve without an
 * active membership. Points them to renew or reach out to staff.
 */
export const MEMBERSHIP_REQUIRED_MESSAGE =
  "We couldn't verify an active BIG membership for this account. If you think this is a mistake, email jessica@brooklineinteractive.org — or sign up for a BIG Membership at https://brooklineinteractive.app.neoncrm.com/forms/membership.";

/** How long a Neon OAuth `state` token is valid — one login round-trip. */
const STATE_TTL_SECONDS = 60 * 10;

/**
 * Issues a short-lived signed `state` token to carry through the Neon OAuth
 * round-trip. Signed with `SESSION_SECRET`, so the callback can prove WE started
 * the flow (CSRF guard).
 *
 * @returns A signed JWT to pass as the OAuth `state` parameter
 */
export function createNeonOAuthState(): string {
  return jwt.sign({ kind: "neon-login", nonce: randomUUID() }, SESSION_SECRET, {
    expiresIn: STATE_TTL_SECONDS,
  });
}

/**
 * Verifies a `state` token returned on the Neon OAuth callback.
 *
 * @param state - The `state` query param from Neon's redirect
 * @returns `true` if the token is a valid, unexpired login state we issued
 */
export function verifyNeonOAuthState(
  state: string | null | undefined
): boolean {
  if (!state) {
    return false;
  }
  try {
    const decoded = jwt.verify(state, SESSION_SECRET) as { kind?: string };
    return decoded?.kind === "neon-login";
  } catch {
    return false;
  }
}

/**
 * Mints a fresh, passwordless Supabase session for an already-verified email via
 * admin `generateLink` (magiclink) → `verifyOtp`. Mirrors the mobile-SSO mint.
 *
 * @param email - The member's email (their Supabase auth account must exist)
 * @returns A mapped {@link AuthSession}
 * @throws {ShelfError} If Supabase returns no verifiable token or session
 */
async function mintSupabaseSession(email: string): Promise<AuthSession> {
  const { data: linkData, error: linkError } =
    await getSupabaseAdmin().auth.admin.generateLink({
      type: "magiclink",
      email,
    });
  if (linkError) {
    throw new ShelfError({
      cause: linkError,
      message: "Could not start your session",
      label,
    });
  }

  const tokenHash = linkData.properties?.hashed_token;
  if (!tokenHash) {
    throw new ShelfError({
      cause: null,
      message: "Supabase did not return a verifiable token",
      label,
    });
  }

  const { data: otpData, error: otpError } =
    await getSupabaseAdmin().auth.verifyOtp({
      token_hash: tokenHash,
      type: "magiclink",
    });
  if (otpError) {
    throw new ShelfError({
      cause: otpError,
      message: "Could not complete your session",
      label,
    });
  }

  if (!otpData.session) {
    throw new ShelfError({
      cause: null,
      message: "The session returned by Supabase is null",
      label,
    });
  }

  return mapAuthSession(otpData.session);
}

/**
 * Provisions (find-or-create + link + role) a BIG member from a Neon constituent
 * and mints their app session.
 *
 * @param neonMember - The resolved, membership-checked Neon constituent
 * @returns The new {@link AuthSession} and the organization id they belong to
 * @throws {ShelfError} 403 if the membership isn't active; 400 if Neon has no
 *   email on file; 503 if the member workspace isn't configured
 */
export async function provisionAndMintNeonSession(
  neonMember: NeonMember
): Promise<{ authSession: AuthSession; organizationId: string }> {
  // Defense in depth — callers gate on this too, but never provision an inactive
  // member even if a caller forgets.
  if (!neonMember.isActiveMember) {
    throw new ShelfError({
      cause: null,
      message:
        "We couldn't find an active Neon membership for your account. Please renew your membership or contact us.",
      label,
      status: 403,
      shouldBeCaptured: false,
    });
  }

  const email = neonMember.email?.trim().toLowerCase();
  if (!email) {
    throw new ShelfError({
      cause: null,
      message:
        "Your Neon record has no email address on file, which we need to create your login. Please add one in Neon or contact us.",
      label,
      status: 400,
      shouldBeCaptured: false,
    });
  }

  const organizationId = NEON_MEMBER_ORG_ID;
  if (!organizationId) {
    throw new ShelfError({
      cause: null,
      message: "The member workspace is not configured (NEON_MEMBER_ORG_ID).",
      label,
      status: 503,
    });
  }

  // Find-or-create the shelf user, attached to BIG as MEMBER. A random password
  // is set purely to satisfy the Supabase account; the member never uses it —
  // they authenticate through Neon (or a magic link).
  await createUserOrAttachOrg({
    email,
    organizationId,
    roles: [OrganizationRoles.MEMBER],
    password: `${randomUUID()}${randomUUID()}`,
    firstName: neonMember.firstName,
    lastName: neonMember.lastName ?? undefined,
    createdWithInvite: true,
  });

  // Stamp the Neon account id so future logins reconcile by identity, not email.
  await db.user.update({
    where: { email },
    data: { neonAccountId: neonMember.neonAccountId },
  });

  const authSession = await mintSupabaseSession(email);
  return { authSession, organizationId };
}

/**
 * Self-signup gate: requires an ACTIVE Neon membership for `email`.
 *
 * - If the Neon API isn't configured (e.g. local dev before creds are wired),
 *   returns `null` WITHOUT blocking — so signup keeps working until Neon is set
 *   up. Once configured, an active membership becomes mandatory.
 * - If configured but no active member matches the email, throws 403.
 *
 * Staff don't go through self-signup (they're invited), so this gate only
 * affects the member self-signup path.
 *
 * @param email - The email the person is trying to sign up with
 * @returns The resolved active {@link NeonMember}, or `null` when Neon is unconfigured
 * @throws {ShelfError} 403 when Neon is configured and no active member matches
 */
export async function assertActiveNeonMemberForSignup(
  email: string
): Promise<NeonMember | null> {
  if (!isNeonApiConfigured()) {
    return null;
  }

  const member = await resolveNeonMemberByEmail(email);
  if (!member || !member.isActiveMember) {
    throw new ShelfError({
      cause: null,
      title: "Active membership required",
      message: MEMBERSHIP_REQUIRED_MESSAGE,
      label,
      status: 403,
      shouldBeCaptured: false,
    });
  }

  return member;
}

/**
 * Best-effort: stamp a freshly-created user with their Neon Account ID. Never
 * throws — a failed link must not break signup/login; a later Neon login or a
 * sync will reconcile it.
 *
 * @param email - The user's email (finds both the shelf user and the Neon record)
 */
export async function linkNeonAccountByEmail(email: string): Promise<void> {
  try {
    if (!isNeonApiConfigured()) {
      return;
    }
    const member = await resolveNeonMemberByEmail(email);
    if (member?.neonAccountId) {
      await db.user.update({
        where: { email },
        data: { neonAccountId: member.neonAccountId },
      });
    }
  } catch {
    // Best-effort — swallow. Linking can be retried on the next Neon login/sync.
  }
}

/**
 * Reservation gate. A MEMBER may reserve only when they are either
 * (a) exempt from the membership check — an admin-invited non-Neon user
 * (volunteer, partner) whose `UserOrganization.membershipCheckExempt` is set —
 * or (b) a currently ACTIVE Neon member. Non-MEMBER roles (staff) are never
 * gated here.
 *
 * Enforced independently of how they logged in (Google, email, Neon, SSO), so a
 * lapsed member can't keep reserving. Fails OPEN if the Neon API is unreachable
 * (a Neon outage must not block reservations) but fails CLOSED on a definitive
 * "not an active member".
 *
 * @param args.userId - The reserving user (the booking's creator)
 * @param args.organizationId - The workspace the reservation is in
 * @throws {ShelfError} 403 when a non-exempt MEMBER has no active Neon membership
 */
export async function assertMemberCanReserve({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string;
}): Promise<void> {
  const membership = await db.userOrganization.findFirst({
    where: { userId, organizationId },
    select: {
      roles: true,
      membershipCheckExempt: true,
      user: { select: { email: true } },
    },
  });

  // Not a member of this workspace, or not a MEMBER (staff/admin) → not our gate.
  if (!membership || !membership.roles.includes(OrganizationRoles.MEMBER)) {
    return;
  }
  // Admin-exempted non-Neon member (volunteer/partner) → always allowed.
  if (membership.membershipCheckExempt) {
    return;
  }
  // Neon not configured (e.g. local dev before creds are wired) → don't block.
  if (!isNeonApiConfigured()) {
    return;
  }

  try {
    const member = await resolveNeonMemberByEmail(membership.user.email);
    if (member?.isActiveMember) {
      return; // active Neon member → allowed
    }
  } catch (cause) {
    // Neon unreachable → fail OPEN so an outage doesn't block reservations.
    Logger.error(
      new ShelfError({
        cause,
        message:
          "Neon membership check failed at reservation time; allowing the reservation (fail-open).",
        additionalData: { userId, organizationId },
        label,
      })
    );
    return;
  }

  // Definitive: no active Neon membership and not exempt → block.
  throw new ShelfError({
    cause: null,
    title: "Active membership required",
    message: MEMBERSHIP_REQUIRED_MESSAGE,
    label,
    status: 403,
    shouldBeCaptured: false,
  });
}
