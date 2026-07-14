/**
 * Membership check (staff, read-only) — `/api/big-membership-check?email=…`
 *
 * BIG-only. Answers one question for the invite dialog: "if I invite this person
 * as a MEMBER, will they actually be able to reserve?"
 *
 * Inviting a MEMBER performs no Neon cross-reference, so staff could invite
 * someone who is not an active member, watch them sign up perfectly happily, and
 * only discover the problem when the person hit "Reserve" and got a 403. This
 * endpoint lets the dialog warn at invite time instead — while the admin can
 * still tick "Doesn't require a BIG membership".
 *
 * Reuses the same resolution enforcement uses: the synced allowlist first, then
 * a live Neon lookup (which also self-heals the allowlist row). Gated on
 * `teamMember:create` — the same permission required to send an invite — because
 * the answer discloses whether an email belongs to a BIG member.
 *
 * @see {@link file://./../../components/settings/invite-user-dialog.tsx} — the caller
 * @see {@link file://./../../modules/big-neon-sync/service.server.ts} — the resolution
 */
import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { isNeonApiConfigured } from "~/integrations/neon-crm/client.server";
import {
  findNeonAllowlistMemberByEmail,
  refreshAllowlistMemberFromNeon,
} from "~/modules/big-neon-sync/service.server";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import { validEmail } from "~/utils/misc";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/**
 * The membership verdict for one email.
 *
 * - `active` — an active BIG member; they'll be able to reserve.
 * - `inactive` — Neon has no active membership for them; they'd be blocked at
 *   reserve time unless exempted.
 * - `unknown` — Neon couldn't be reached, so we can't say. Never presented as a
 *   negative: "couldn't check" must not read as "not a member".
 * - `unconfigured` — Neon isn't wired up on this install; nothing is enforced.
 */
export type MembershipCheckState =
  | "active"
  | "inactive"
  | "unknown"
  | "unconfigured";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();

  try {
    // Same gate as sending the invite: this answer is about a real person.
    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.teamMember,
      action: PermissionAction.create,
    });

    const email = (new URL(request.url).searchParams.get("email") ?? "")
      .trim()
      .toLowerCase();

    if (!email || !validEmail(email)) {
      return payload({ state: "unknown" as MembershipCheckState, name: null });
    }

    if (!isNeonApiConfigured()) {
      return payload({
        state: "unconfigured" as MembershipCheckState,
        name: null,
      });
    }

    // The synced allowlist answers most checks without touching Neon.
    const known = await findNeonAllowlistMemberByEmail(email);
    if (known) {
      return payload({
        state: "active" as MembershipCheckState,
        name:
          [known.firstName, known.lastName].filter(Boolean).join(" ") || null,
      });
    }

    // Not on the list — ask Neon directly before saying "no", exactly as the
    // reserve gate does. Catches someone who joined since the last sync.
    try {
      const live = await refreshAllowlistMemberFromNeon(email);
      return payload({
        state: (live ? "active" : "inactive") as MembershipCheckState,
        name: live
          ? [live.firstName, live.lastName].filter(Boolean).join(" ") || null
          : null,
      });
    } catch {
      // Neon unreachable — say so plainly rather than implying they're not a member.
      return payload({ state: "unknown" as MembershipCheckState, name: null });
    }
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
