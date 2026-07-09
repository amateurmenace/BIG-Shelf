/**
 * Member Sync (admin) — `/settings/member-sync`
 *
 * BIG-only. Admins refresh the local active-member allowlist from Neon CRM with
 * one button. The sync pulls the current active-member list from the Neon API
 * and stores it in the `NeonAllowlistMember` table (replacing the previous set).
 *
 * It creates NO login accounts, Supabase users, or passwords — people still sign
 * in by their own method (Google / Microsoft / email OTP) and are cross-
 * referenced against this list at signup and when they try to reserve.
 *
 * The "Check membership" tool diagnoses "in Neon but can't get in" by showing
 * both whether the email is on the synced allowlist and its live Neon status.
 *
 * Gated on `generalSettings:update`, which only ADMIN/OWNER hold.
 *
 * @see {@link file://./../../modules/big-neon-sync/service.server.ts}
 * @see {@link file://./../../modules/big-neon-auth/service.server.ts} — the enforcement that reads the allowlist
 */
import type { NeonAllowlistMember } from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import { useDisabled } from "~/hooks/use-disabled";
import {
  isNeonApiConfigured,
  resolveNeonMemberByEmail,
  type NeonMember,
} from "~/integrations/neon-crm/client.server";
import {
  findNeonAllowlistMemberByEmail,
  getNeonAllowlistStatus,
  syncNeonAllowlist,
  type NeonAllowlistStatus,
  type NeonAllowlistSyncResult,
} from "~/modules/big-neon-sync/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { NEON_MEMBER_ORG_ID } from "~/utils/env";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/**
 * Member sync operates on GLOBAL Neon data (the allowlist + live Neon lookups),
 * not on the caller's selected workspace — yet `requirePermission` only proves
 * the caller is an admin of whatever org they currently have selected. Every
 * self-signed member owns an auto-created "Personal" workspace where they are
 * OWNER (and OWNER holds `generalSettings:update`), so without this guard a
 * member could select that personal org and reach the sync + the Neon PII
 * lookup. Restrict the tool to admins acting IN the member workspace.
 *
 * @param organizationId - The caller's currently-selected organization
 * @throws {ShelfError} 403 when the selected org isn't the member workspace
 */
function assertMemberWorkspace(organizationId: string): void {
  if (NEON_MEMBER_ORG_ID && organizationId !== NEON_MEMBER_ORG_ID) {
    throw new ShelfError({
      cause: null,
      title: "Not available in this workspace",
      message:
        "Member sync is only available to admins of the member workspace.",
      label: "Neon Sync",
      status: 403,
      shouldBeCaptured: false,
    });
  }
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.read,
    });
    assertMemberWorkspace(organizationId);

    const status: NeonAllowlistStatus = await getNeonAllowlistStatus();

    return payload({
      title: "Member sync",
      neonConfigured: isNeonApiConfigured(),
      memberOrgConfigured: Boolean(NEON_MEMBER_ORG_ID),
      status,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

/** Result of the "Check membership" diagnostic. */
type MembershipCheck = {
  queriedEmail: string;
  /** Whether the email is on the synced local allowlist. */
  onAllowlist: boolean;
  /** The synced allowlist row, if any. */
  allowlist: NeonAllowlistMember | null;
  /** The live Neon lookup result (may lag or lead the synced list). */
  live: NeonMember | null;
  /** Set when the live Neon lookup itself failed (the synced answer still stands). */
  liveError: string | null;
};

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.update,
    });
    assertMemberWorkspace(organizationId);

    const formData = await request.formData();
    const intent = formData.get("intent");

    // Read-only diagnostic — "in Neon but can't get in?". Shares this route's
    // generalSettings:update gate; performs no writes. Shows both the synced
    // allowlist answer (what enforcement actually checks) and a live Neon lookup.
    if (intent === "check") {
      const email = String(formData.get("email") ?? "").trim();
      const allowlist = email
        ? await findNeonAllowlistMemberByEmail(email)
        : null;

      let live: NeonMember | null = null;
      let liveError: string | null = null;
      if (email) {
        // Best-effort — a Neon outage must not break the diagnostic; the synced
        // allowlist answer is the one enforcement uses anyway.
        try {
          live = await resolveNeonMemberByEmail(email);
        } catch (cause) {
          liveError =
            cause instanceof Error ? cause.message : "Live Neon lookup failed";
        }
      }

      const check: MembershipCheck = {
        queriedEmail: email,
        onAllowlist: Boolean(allowlist),
        allowlist,
        live,
        liveError,
      };
      return payload({ check });
    }

    // "sync" refreshes the allowlist from Neon (no accounts created).
    const synced: NeonAllowlistSyncResult = await syncNeonAllowlist();
    return payload({ synced });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: appendToMetaTitle(data?.title) },
];

export const handle = { name: "settings.member-sync" };

export default function MemberSyncSettings() {
  const { neonConfigured, memberOrgConfigured, status } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const disabled = useDisabled();

  const synced =
    actionData && "synced" in actionData ? actionData.synced : undefined;
  const check =
    actionData && "check" in actionData ? actionData.check : undefined;
  const errorMessage =
    actionData && "error" in actionData ? actionData.error?.message : undefined;

  const ready = neonConfigured && memberOrgConfigured;
  // After a sync the loader hasn't re-run, so surface the just-synced count.
  const activeCount = synced?.activeCount ?? status.activeCount;

  return (
    <div className="mb-2.5 flex flex-col gap-4 rounded border border-gray-200 bg-white px-6 py-5">
      <div>
        <h3 className="text-text-lg font-semibold">Member sync</h3>
        <p className="mt-1 text-sm text-gray-600">
          Pull the current active-member list from Neon CRM. Neon is the source
          of truth. This only updates the membership allowlist — it never
          creates logins or passwords. Members sign in with Google, Microsoft,
          or an email code, and are matched against this list.
        </p>
      </div>

      {!ready ? (
        <div className="rounded border border-[#FFE082] bg-[#FFF8E1] px-4 py-3 text-sm text-gray-700">
          {!neonConfigured ? (
            <p>
              Neon isn&apos;t configured for this site. Set{" "}
              <code>NEON_ORG_ID</code> and <code>NEON_API_KEY</code> (Fly
              secrets in production) to enable member sync.
            </p>
          ) : (
            <p>
              The member workspace isn&apos;t configured. Set{" "}
              <code>NEON_MEMBER_ORG_ID</code> to the workspace members are
              matched into.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Status + action card */}
          <div className="flex flex-col gap-4 rounded border border-gray-200 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <span className="text-3xl font-semibold tabular-nums text-gray-900">
                {activeCount}
              </span>
              <div className="flex flex-col">
                <span className="text-sm font-medium text-gray-700">
                  active member{activeCount === 1 ? "" : "s"} on the allowlist
                </span>
                <span className="text-xs text-gray-500">
                  {status.lastSyncedAt ? (
                    <>
                      Last synced{" "}
                      <DateS date={status.lastSyncedAt} includeTime />
                    </>
                  ) : (
                    "Never synced — run a sync to build the allowlist"
                  )}
                </span>
              </div>
            </div>
            <Form method="post">
              <input type="hidden" name="intent" value="sync" />
              <Button type="submit" disabled={disabled}>
                {disabled ? "Syncing…" : "Sync members from Neon"}
              </Button>
            </Form>
          </div>

          {synced ? (
            <p className="text-sm font-medium text-success-600">
              Synced {synced.activeCount} active member
              {synced.activeCount === 1 ? "" : "s"} from Neon.
            </p>
          ) : null}

          <p className="text-xs text-gray-500">
            This runs automatically every night — use the button only when you
            want to refresh the allowlist right away.
          </p>

          {/* Diagnostic */}
          <div className="flex flex-col gap-1 border-t border-gray-100 pt-4">
            <span className="text-xs font-medium text-gray-700">
              Check a member&apos;s status
            </span>
            <Form method="post" className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="intent" value="check" />
              <input
                type="email"
                name="email"
                required
                placeholder="member@example.com"
                aria-label="Member email to check"
                className="rounded border border-gray-200 px-3 py-1.5 text-sm"
              />
              <Button type="submit" variant="secondary" disabled={disabled}>
                {disabled ? "Checking…" : "Check membership"}
              </Button>
            </Form>
            <span className="text-xs text-gray-500">
              Compares the synced allowlist (what sign-in and reserving actually
              check) against the member&apos;s live Neon status.
            </span>
          </div>
        </div>
      )}

      {errorMessage ? (
        <p className="text-sm text-error-500">{errorMessage}</p>
      ) : null}

      {check ? <CheckResult check={check} /> : null}
    </div>
  );
}

/**
 * Renders the "Check membership" diagnostic: the synced-allowlist answer (which
 * enforcement uses) side-by-side with the live Neon status, so an admin can tell
 * "not on the list" from "on the list but lapsed in Neon since the last sync".
 */
function CheckResult({ check }: { check: MembershipCheck }) {
  return (
    <div className="flex flex-col gap-2 rounded border border-gray-200 p-3 text-sm">
      {/* Synced allowlist — the authoritative answer for sign-in / reserving */}
      <p className="text-gray-700">
        <span className="font-medium">Synced allowlist:</span>{" "}
        {check.onAllowlist ? (
          <span className="font-medium text-success-600">
            on the list ✓ — can sign in &amp; reserve
          </span>
        ) : (
          <span className="font-medium text-error-500">
            not on the list — will see the membership message
          </span>
        )}
        {check.allowlist ? (
          <span className="text-gray-500">
            {" "}
            ({check.allowlist.firstName} {check.allowlist.lastName}, synced{" "}
            <DateS date={check.allowlist.syncedAt} includeTime />)
          </span>
        ) : null}
      </p>

      {/* Live Neon status — may lead/lag the synced list until the next sync */}
      <p className="text-gray-700">
        <span className="font-medium">Live Neon:</span>{" "}
        {check.liveError ? (
          <span className="text-gray-500">
            couldn&apos;t reach Neon ({check.liveError})
          </span>
        ) : !check.live ? (
          <span className="text-gray-500">
            no Neon account found for{" "}
            <span className="font-medium">{check.queriedEmail}</span>
          </span>
        ) : (
          <span className="text-gray-700">
            {check.live.firstName} {check.live.lastName} —{" "}
            <span
              className={
                check.live.isActiveMember
                  ? "font-medium text-success-600"
                  : "font-medium text-error-500"
              }
            >
              {check.live.isActiveMember ? "ACTIVE ✓" : "found but NOT active"}
            </span>
          </span>
        )}
      </p>

      {/* Actionable hint when the two disagree */}
      {!check.onAllowlist && check.live?.isActiveMember ? (
        <p className="text-xs text-gray-500">
          Active in Neon but not yet on the allowlist — run a sync to add them.
        </p>
      ) : null}
      {check.onAllowlist && check.live && !check.live.isActiveMember ? (
        <p className="text-xs text-gray-500">
          On the allowlist but no longer active in Neon — a sync will remove
          them.
        </p>
      ) : null}
    </div>
  );
}
