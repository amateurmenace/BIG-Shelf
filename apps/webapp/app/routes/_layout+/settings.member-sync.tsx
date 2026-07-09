/**
 * Member Sync (admin) — `/settings/member-sync`
 *
 * BIG-only. Admins pull active members from Neon CRM in bulk and provision them
 * as MEMBER logins in the workspace. "Preview" is a safe, read-only projection;
 * "Sync now" performs the provisioning (idempotent — safe to re-run).
 *
 * Gated on `generalSettings:update`, which only ADMIN/OWNER hold.
 *
 * @see {@link file://./../../modules/big-neon-sync/service.server.ts}
 */
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import { Button } from "~/components/shared/button";
import { useDisabled } from "~/hooks/use-disabled";
import {
  isNeonApiConfigured,
  resolveNeonMemberByEmail,
  type NeonMember,
} from "~/integrations/neon-crm/client.server";
import {
  previewNeonMemberSync,
  syncNeonMembers,
  type NeonSyncResult,
} from "~/modules/big-neon-sync/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { NEON_MEMBER_ORG_ID } from "~/utils/env";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.read,
    });

    return payload({
      title: "Member sync",
      neonConfigured: isNeonApiConfigured(),
      memberOrgConfigured: Boolean(NEON_MEMBER_ORG_ID),
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.update,
    });

    const formData = await request.formData();
    const intent = formData.get("intent");

    // Read-only membership lookup — diagnoses "in Neon but not getting verified".
    // Shares this route's generalSettings:update gate; performs no writes.
    if (intent === "check") {
      const email = String(formData.get("email") ?? "").trim();
      const member: NeonMember | null = email
        ? await resolveNeonMemberByEmail(email)
        : null;
      return payload({ check: { queriedEmail: email, member } });
    }

    // "sync" writes; anything else is the read-only preview.
    const result: NeonSyncResult =
      intent === "sync"
        ? await syncNeonMembers()
        : await previewNeonMemberSync();

    return payload({ result });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: appendToMetaTitle(data?.title) },
];

export const handle = { name: "settings.member-sync" };

/** A labeled count in the results grid. */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col rounded border border-gray-200 p-3">
      <span className="text-2xl font-semibold tabular-nums text-gray-900">
        {value}
      </span>
      <span className="text-xs text-gray-500">{label}</span>
    </div>
  );
}

export default function MemberSyncSettings() {
  const { neonConfigured, memberOrgConfigured } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const disabled = useDisabled();

  const result =
    actionData && "result" in actionData ? actionData.result : undefined;
  const check =
    actionData && "check" in actionData ? actionData.check : undefined;
  const errorMessage =
    actionData && "error" in actionData ? actionData.error?.message : undefined;

  const ready = neonConfigured && memberOrgConfigured;

  return (
    <div className="mb-2.5 flex flex-col gap-4 rounded border border-gray-200 bg-white px-6 py-5">
      <div>
        <h3 className="text-text-lg font-semibold">Member sync</h3>
        <p className="mt-1 text-sm text-gray-600">
          Pull active members from Neon CRM and provision them as member logins
          in this workspace. Neon is the source of truth. This is safe to re-run
          — existing members are left untouched.
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
              <code>NEON_MEMBER_ORG_ID</code> to the workspace members should be
              synced into.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Form method="post">
              <input type="hidden" name="intent" value="preview" />
              <Button type="submit" variant="secondary" disabled={disabled}>
                {disabled ? "Working…" : "Preview"}
              </Button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="sync" />
              <Button type="submit" disabled={disabled}>
                {disabled ? "Syncing…" : "Sync now"}
              </Button>
            </Form>
            <span className="text-xs text-gray-500">
              Preview is read-only. Sync now provisions/updates member logins.
            </span>
          </div>

          <div className="flex flex-col gap-1 border-t border-gray-100 pt-3">
            <span className="text-xs font-medium text-gray-700">
              Check a member&apos;s Neon status
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
              Diagnose &quot;in Neon but not getting verified&quot; — matches by
              any email on the member&apos;s Neon record.
            </span>
          </div>
        </div>
      )}

      {errorMessage ? (
        <p className="text-sm text-error-500">{errorMessage}</p>
      ) : null}

      {check ? (
        <div className="rounded border border-gray-200 p-3 text-sm">
          {!check.member ? (
            <p className="text-gray-700">
              No match — no Neon account found for{" "}
              <span className="font-medium">{check.queriedEmail}</span>. If they
              have a membership, add this email to their Neon record.
            </p>
          ) : (
            <p className="text-gray-700">
              Found{" "}
              <span className="font-medium">
                {check.member.firstName} {check.member.lastName}
              </span>{" "}
              (<span className="font-medium">{check.member.email}</span>) —{" "}
              <span
                className={
                  check.member.isActiveMember
                    ? "font-medium text-success-600"
                    : "font-medium text-error-500"
                }
              >
                {check.member.isActiveMember
                  ? "ACTIVE member ✓"
                  : "found but NOT active"}
              </span>
            </p>
          )}
        </div>
      ) : null}

      {result ? (
        <div className="mt-1">
          <p className="mb-3 text-sm font-medium text-gray-700">
            {result.previewOnly
              ? "Preview — nothing was changed:"
              : "Sync complete:"}{" "}
            <span className="text-gray-500">
              {result.totalActive} active member
              {result.totalActive === 1 ? "" : "s"} in Neon
            </span>
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat
              label={result.previewOnly ? "Would create" : "Created"}
              value={result.created}
            />
            <Stat
              label={result.previewOnly ? "Would add role" : "Role added"}
              value={result.attached}
            />
            <Stat label="Already members" value={result.skipped} />
            <Stat
              label={result.previewOnly ? "Would deactivate" : "Deactivated"}
              value={result.deactivated}
            />
            <Stat label="Failed" value={result.failed} />
          </div>

          {result.errors.length > 0 ? (
            <div className="mt-4">
              <p className="mb-1 text-xs font-medium text-gray-700">
                Errors ({result.errors.length}
                {result.failed > result.errors.length
                  ? ` of ${result.failed} shown`
                  : ""}
                ):
              </p>
              <ul className="max-h-40 overflow-y-auto rounded border border-gray-100 text-xs">
                {result.errors.map((err) => (
                  <li
                    key={err.email}
                    className="border-b border-gray-100 px-3 py-1.5 last:border-b-0"
                  >
                    <span className="font-medium text-gray-700">
                      {err.email}
                    </span>{" "}
                    <span className="text-gray-500">— {err.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
