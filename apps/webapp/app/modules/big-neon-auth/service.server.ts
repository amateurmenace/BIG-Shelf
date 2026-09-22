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
import { OrganizationRoles, type NeonAllowlistMember } from "@prisma/client";
import jwt from "jsonwebtoken";
import type { AuthSession } from "@server/session";
import { db } from "~/database/db.server";
import {
  isNeonApiConfigured,
  type NeonMember,
} from "~/integrations/neon-crm/client.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import { mapAuthSession } from "~/modules/auth/mappers.server";
import {
  findNeonAllowlistMemberByEmail,
  isAllowlistTrustworthy,
  isEmailOnNeonAllowlist,
  refreshAllowlistMemberFromNeon,
} from "~/modules/big-neon-sync/service.server";
import {
  createUserOrAttachOrg,
  findUserByEmail,
} from "~/modules/user/service.server";
import { NEON_MEMBER_ORG_ID, SESSION_SECRET } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { MEMBERSHIP_REQUIRED_MESSAGE } from "./shared";

const label = "Neon Auth" as const;

// Lives in `shared.ts` so route COMPONENTS can render it without importing this
// server-only module (which would drag Prisma/Supabase into the client bundle).
// Re-exported here so existing server-side imports keep working.
export { MEMBERSHIP_REQUIRED_MESSAGE } from "./shared";

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
 * Self-signup gate: cross-references `email` against the synced active-member
 * allowlist (the `NeonAllowlistMember` table refreshed by the admin sync). No
 * live Neon API call — the admin re-syncs to refresh membership.
 *
 * - If the Neon API isn't configured (e.g. local dev before creds are wired),
 *   returns `null` WITHOUT blocking — so signup keeps working until Neon is set
 *   up. Once configured, being on the synced allowlist becomes mandatory.
 * - If configured but the email isn't on the allowlist, throws 403.
 *
 * Staff don't go through self-signup (they're invited), so this gate only
 * affects the member self-signup path.
 *
 * @param email - The email the person is trying to sign up with
 * @returns The matched {@link NeonAllowlistMember} (its name / account id are used
 *   to provision the member), or `null` when Neon is unconfigured
 * @throws {ShelfError} 403 when Neon is configured and the email isn't on the allowlist
 */
export async function assertActiveNeonMemberForSignup(
  email: string
): Promise<NeonAllowlistMember | null> {
  if (!isNeonApiConfigured()) {
    return null;
  }

  const member = await findNeonAllowlistMemberByEmail(email);
  if (member) {
    return member;
  }

  // Not on the list. Before turning away someone who may have joined Neon
  // minutes ago, ask Neon directly — a nightly snapshot is not grounds to reject
  // a brand-new member at the door. A hit self-heals the allowlist.
  try {
    const live = await refreshAllowlistMemberFromNeon(email);
    if (live) {
      return live;
    }
  } catch (cause) {
    // Neon is unreachable / misconfigured. We can't confirm they're a member,
    // but we equally can't confirm they aren't — and signup is the worst place
    // to guess wrong. Log loudly and let them through; the reserve gate re-checks.
    Logger.error(
      new ShelfError({
        cause,
        message:
          "Could not verify Neon membership at signup; allowing signup (fail-open). Fix the Neon sync.",
        additionalData: { email },
        label,
      })
    );
    return null;
  }

  throw new ShelfError({
    cause: null,
    title: "Active membership required",
    message: MEMBERSHIP_REQUIRED_MESSAGE,
    label,
    status: 403,
    shouldBeCaptured: false,
  });
}

/**
 * The signup gate for the OTP flow, decided from the DATABASE rather than from
 * what the client said it was doing.
 *
 * Supabase's email-OTP flow CREATES an account for an unknown email — there is no
 * such thing as "just logging in" with an address that has no account yet. But
 * the membership gate used to hang off the `mode` field posted by the form
 * (`signup` vs `login`), which is client-supplied. So anyone could go to /login,
 * click "Continue with OTP" (which posts `mode=login`), and be handed a real
 * account with a personal workspace, never once meeting the membership check.
 * `/resend-otp` had no gate at all.
 *
 * The fix is to stop asking the form and start asking the database: if no Shelf
 * user exists for this email, completing this OTP will MINT one — that is a
 * signup, whatever the form claimed, and it must pass the same gate as `/join`.
 *
 * @param email - The email an OTP is about to be sent to / verified for
 * @throws {ShelfError} 403 when this would create an account for a non-member
 */
export async function assertActiveNeonMemberForOtp(
  email: string
): Promise<void> {
  if (!isNeonApiConfigured()) {
    return;
  }

  // An existing user is a genuine login — nothing is being created, so the
  // signup gate doesn't apply. (Lapsed members are still stopped at the point
  // that actually matters: reserving.)
  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    return;
  }

  await assertActiveNeonMemberForSignup(email);
}

/**
 * Best-effort: stamp a freshly-created user with their Neon Account ID from the
 * synced allowlist. Never throws — a failed link must not break signup/login; a
 * later Neon login or a sync will reconcile it.
 *
 * @param email - The user's email (finds both the shelf user and the allowlist row)
 */
export async function linkNeonAccountByEmail(email: string): Promise<void> {
  try {
    if (!isNeonApiConfigured()) {
      return;
    }
    const member = await findNeonAllowlistMemberByEmail(email);
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
 * Core reservation-eligibility rule, returned as a boolean so callers that need
 * to BRANCH rather than throw can reuse the exact same logic — notably the
 * kiosk walk-up flow, which shows a "become a member" sign-up screen for an
 * ineligible email instead of erroring out. {@link assertMemberCanReserve}
 * wraps this and throws.
 *
 * A user is eligible to reserve when ANY of these hold:
 * - they are not a MEMBER of the workspace (staff/admin are never gated here);
 * - their MEMBER row is `membershipCheckExempt` (an admin-invited non-Neon user
 *   — volunteer, partner);
 * - Neon isn't configured (fail-open so an install works before creds are wired);
 * - their email is on the synced active-member allowlist (`NeonAllowlistMember`);
 * - the allowlist ISN'T TRUSTWORTHY (never synced / empty / stale) — a broken
 *   integration must not punish paying members;
 * - Neon itself, asked live, says they're an active member (covers someone who
 *   joined or renewed since the last nightly sync).
 *
 * ## Denial is the expensive mistake
 *
 * This gate exists to stop a lapsed member reserving. It is NOT worth locking out
 * a paying member to achieve that. So every uncertain path — a DB blip, a stale
 * allowlist, an unreachable Neon — resolves to ALLOW, loudly logged. Only a
 * definitive "the allowlist is fresh, they're not on it, and Neon confirms
 * they're not active" returns false.
 *
 * That ordering is deliberate: the local allowlist answers the overwhelming
 * majority of checks with a single indexed lookup, and Neon is only consulted on
 * the path where we would otherwise deny someone.
 *
 * @param args.userId - The user whose membership is in question
 * @param args.organizationId - The workspace the reservation is in
 * @returns Whether the user may currently reserve
 */
export async function isMemberReservationEligible({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string;
}): Promise<boolean> {
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
    return true;
  }
  // Admin-exempted non-Neon member (volunteer/partner) → always allowed.
  if (membership.membershipCheckExempt) {
    return true;
  }
  // Neon not configured (e.g. local dev before creds are wired) → don't block.
  if (!isNeonApiConfigured()) {
    return true;
  }

  const email = membership.user.email;

  try {
    // The common case: a single indexed lookup on the synced allowlist.
    if (await isEmailOnNeonAllowlist(email)) {
      return true;
    }

    // They're not on the list — but is the list even worth believing? A revoked
    // API key once froze it for four days while this gate confidently denied
    // every member who had joined since. A broken sync is our problem, not theirs.
    if (!(await isAllowlistTrustworthy())) {
      Logger.error(
        new ShelfError({
          cause: null,
          message:
            "Neon allowlist is stale/empty (the sync is failing) — allowing the reservation rather than blocking a possibly-active member (fail-open). Fix the Neon sync.",
          additionalData: { userId, organizationId },
          label,
        })
      );
      return true;
    }

    // The list is fresh and they're not on it. Before denying a real person, ask
    // Neon directly — they may have joined or renewed since last night's sync.
    // A hit self-heals the allowlist, so this costs one API call, once.
    const live = await refreshAllowlistMemberFromNeon(email);
    return Boolean(live);
  } catch (cause) {
    // Something we depend on broke (the DB, or Neon itself). We cannot VERIFY
    // they're inactive, and "couldn't verify" must never render as "not a
    // member" — fail OPEN and make the failure loud.
    Logger.error(
      new ShelfError({
        cause,
        message:
          "Could not verify Neon membership at reservation time; allowing the reservation (fail-open).",
        additionalData: { userId, organizationId },
        label,
      })
    );
    return true;
  }
}

/**
 * Membership check for someone with NO account — the kiosk walk-up case.
 *
 * {@link isMemberReservationEligible} starts from an account: a role, an
 * exemption flag, an email. A paid-up Neon member who has never signed in has
 * none of those. Their row in the synced directory is the only evidence of who
 * they are — and it is what their account-less record gets built from. So this
 * asks the directory, and only when they are not in it asks Neon live (a hit
 * self-heals the row, exactly as at signup).
 *
 * Deliberately NOT fail-open like the account gate. With no account and no
 * directory row there is nobody to book for, and failing open would mean
 * booking rooms in the name of any string typed into a public wall. It fails
 * SOFT instead: an unreachable Neon is reported as "couldn't check", never as
 * "not a member", so a paying member is told to ask staff — not to buy a
 * membership they already have.
 *
 * @param email - The email typed at the kiosk
 * @returns Their directory row when they are an active member; `null` when
 *   Neon confirms they are not one
 * @throws {ShelfError} 503 when membership can't be determined right now
 *   (Neon unreachable or unconfigured, and they were not in the last sync)
 */
export async function findActiveMemberWithoutAccount(
  email: string
): Promise<NeonAllowlistMember | null> {
  const listed = await findNeonAllowlistMemberByEmail(email);
  if (listed) {
    return listed;
  }

  try {
    // Throws when Neon is unconfigured or unreachable; null means "not active".
    return await refreshAllowlistMemberFromNeon(email);
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        message:
          "Could not verify Neon membership for a kiosk walk-up with no account; asked them to see staff.",
        additionalData: { email },
        label,
      })
    );
    throw new ShelfError({
      cause: null,
      title: "Couldn't check membership",
      message:
        "We couldn't confirm your membership just now. Please ask a member of staff to book this for you.",
      status: 503,
      shouldBeCaptured: false,
      label,
    });
  }
}

/**
 * Reservation gate. A MEMBER may reserve only when
 * {@link isMemberReservationEligible} is true; non-MEMBER roles (staff) are
 * never gated here.
 *
 * Enforced independently of how they logged in (Google, email, Neon, SSO), so a
 * lapsed member can't keep reserving. Placed in `createBooking` so it covers
 * every reservation entry point where the reserving MEMBER is the booking's
 * creator. (Staff-mediated flows — e.g. the kiosk booking someone in as
 * custodian — must check the CUSTODIAN's membership at the call site instead,
 * since the creator there is a staff account this gate intentionally skips.)
 *
 * @param args.userId - The reserving user (the booking's creator)
 * @param args.organizationId - The workspace the reservation is in
 * @throws {ShelfError} 403 when a non-exempt MEMBER is not on the active-member allowlist
 */
export async function assertMemberCanReserve({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string;
}): Promise<void> {
  if (await isMemberReservationEligible({ userId, organizationId })) {
    return;
  }

  // Definitive: not on the active-member allowlist and not exempt → block.
  throw new ShelfError({
    cause: null,
    title: "Active membership required",
    message: MEMBERSHIP_REQUIRED_MESSAGE,
    label,
    status: 403,
    shouldBeCaptured: false,
  });
}
