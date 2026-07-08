/**
 * Asset Condition & Maintenance tab — `/assets/:assetId/condition`
 *
 * A documented history of an asset's condition over time. Staff (asset:update)
 * add dated entries — routine condition report / damage / maintenance /
 * inspection — with an optional grade, a note, and an optional photo. The
 * timeline below shows every entry newest-first with its photos.
 *
 * @see {@link file://./../../modules/big-asset-condition/service.server.ts}
 * @see {@link file://./assets.$assetId.tsx} — the tab is registered here
 */
import type { AssetConditionGrade, AssetConditionType } from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
} from "react-router";
import { z } from "zod";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import { db } from "~/database/db.server";
import { useDisabled } from "~/hooks/use-disabled";
import {
  createConditionEntryFromRequest,
  getAssetConditionLog,
} from "~/modules/big-asset-condition/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, getParams, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/** Human labels for the condition entry types. */
const TYPE_LABELS: Record<AssetConditionType, string> = {
  CONDITION: "Condition report",
  DAMAGE: "Damage",
  MAINTENANCE: "Maintenance",
  INSPECTION: "Inspection",
};

/** Badge classes per entry type. */
const TYPE_BADGE: Record<AssetConditionType, string> = {
  CONDITION: "bg-gray-100 text-gray-700",
  DAMAGE: "bg-red-100 text-red-700",
  MAINTENANCE: "bg-blue-100 text-blue-700",
  INSPECTION: "bg-violet-100 text-violet-700",
};

/** Human labels for the condition grades. */
const GRADE_LABELS: Record<AssetConditionGrade, string> = {
  GOOD: "Good",
  FAIR: "Fair",
  POOR: "Poor",
  OUT_OF_SERVICE: "Out of service",
};

// Option order as string literals. The Prisma enum *values* resolve to
// `undefined` in the browser build, so the client must not reference them.
const TYPE_OPTIONS: AssetConditionType[] = [
  "CONDITION",
  "DAMAGE",
  "MAINTENANCE",
  "INSPECTION",
];
const GRADE_OPTIONS: AssetConditionGrade[] = [
  "GOOD",
  "FAIR",
  "POOR",
  "OUT_OF_SERVICE",
];

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  const { assetId } = getParams(params, z.object({ assetId: z.string() }));

  try {
    // asset:update = staff (admins/owners). Members/base can't reach this tab.
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.update,
    });

    // Org-scope the asset (proves it belongs to the caller's workspace).
    const asset = await db.asset.findFirst({
      where: { id: assetId, organizationId },
      select: { id: true, title: true },
    });
    if (!asset) {
      throw new ShelfError({
        cause: null,
        message: "Asset not found in this workspace.",
        label: "Asset Condition",
        status: 404,
        shouldBeCaptured: false,
      });
    }

    const entries = await getAssetConditionLog({ assetId, organizationId });

    const header: HeaderData = { title: `${asset.title} — Condition` };

    return data(payload({ header, assetId, entries }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, assetId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request, params }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  const { assetId } = getParams(params, z.object({ assetId: z.string() }));

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.update,
    });

    await createConditionEntryFromRequest({
      request,
      assetId,
      organizationId,
      createdById: userId,
    });

    return redirect(`/assets/${assetId}/condition`);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, assetId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title) },
];

/** The condition/maintenance timeline + add-entry form. */
export default function AssetConditionTab() {
  const { entries } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const disabled = useDisabled();

  return (
    <div className="mt-4">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
        {/* Add entry */}
        <div className="rounded border border-gray-200 bg-white p-4 md:p-6">
          <h3 className="mb-4 text-sm font-semibold text-gray-900">
            Log condition or maintenance
          </h3>
          <Form
            method="post"
            encType="multipart/form-data"
            className="flex flex-col gap-3"
          >
            <label className="text-sm font-medium text-gray-700">
              Type
              <select
                name="type"
                defaultValue="CONDITION"
                disabled={disabled}
                className="mt-1 h-10 w-full rounded border border-gray-300 px-2 text-sm"
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm font-medium text-gray-700">
              Condition grade (optional)
              <select
                name="grade"
                defaultValue=""
                disabled={disabled}
                className="mt-1 h-10 w-full rounded border border-gray-300 px-2 text-sm"
              >
                <option value="">— No grade —</option>
                {GRADE_OPTIONS.map((g) => (
                  <option key={g} value={g}>
                    {GRADE_LABELS[g]}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm font-medium text-gray-700">
              Note
              <textarea
                name="note"
                rows={4}
                required
                disabled={disabled}
                placeholder="Describe the condition, damage, or maintenance performed…"
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>

            <label className="text-sm font-medium text-gray-700">
              Photo (optional)
              <input
                type="file"
                name="image"
                accept="image/*"
                disabled={disabled}
                className="mt-1 block w-full text-sm text-gray-600 file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm"
              />
            </label>

            {actionData?.error ? (
              <p className="text-sm text-error-500">
                {actionData.error.message}
              </p>
            ) : null}

            <Button type="submit" disabled={disabled} className="mt-1">
              {disabled ? "Saving…" : "Add entry"}
            </Button>
          </Form>
        </div>

        {/* Timeline */}
        <div className="rounded border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-4 py-3 md:px-6">
            <h3 className="text-sm font-semibold text-gray-900">
              History{" "}
              <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                {entries.length}
              </span>
            </h3>
          </div>

          {entries.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-600">
              No condition or maintenance has been logged for this asset yet.
            </div>
          ) : (
            <ul>
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="border-b border-gray-100 p-4 last:border-b-0 md:p-6"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        TYPE_BADGE[entry.type]
                      }`}
                    >
                      {TYPE_LABELS[entry.type]}
                    </span>
                    {entry.grade ? (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                        {GRADE_LABELS[entry.grade]}
                      </span>
                    ) : null}
                    <span className="text-xs text-gray-400">
                      <DateS date={entry.createdAt} includeTime />
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-gray-800">
                    {entry.note}
                  </p>
                  {entry.images.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {entry.images.map((img) => (
                        <a
                          key={img.id}
                          href={img.imageUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="block"
                        >
                          <img
                            src={img.thumbnailUrl ?? img.imageUrl}
                            alt="Logged equipment condition"
                            className="size-20 rounded border border-gray-200 object-cover"
                          />
                        </a>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
