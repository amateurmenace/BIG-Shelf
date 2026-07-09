/**
 * Asset Guides tab — `/assets/:assetId/guides`
 *
 * Staff (asset:update) manage the learning content members see on the
 * equipment info page (`/reserve/equipment/:assetId`): links to manuals /
 * documents, video explainers (YouTube/Vimeo URLs render as embeds for
 * members), and other helpful links. List + add + remove.
 *
 * @see {@link file://./../../modules/big-equipment/service.server.ts}
 * @see {@link file://./reserve.equipment_.$assetId.tsx} — where members see these
 * @see {@link file://./assets.$assetId.tsx} — the tab is registered here
 */
import type { AssetGuideKind } from "@prisma/client";
import { BookOpenIcon, LinkIcon, PlayIcon } from "lucide-react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import { z } from "zod";
import Input from "~/components/forms/input";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { useDisabled } from "~/hooks/use-disabled";
import {
  AssetGuideSchema,
  createAssetGuide,
  deleteAssetGuide,
  listAssetGuides,
} from "~/modules/big-equipment/service.server";
import {
  ASSET_GUIDE_KIND_LABEL,
  ASSET_GUIDE_KINDS,
  videoEmbedUrl,
} from "~/modules/big-equipment/shared";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { getValidationErrors } from "~/utils/http";
import type { DataOrErrorResponse } from "~/utils/http.server";
import { error, getParams, parseData, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/** Route params — the asset id comes from the URL and is untrusted. */
const paramsSchema = z.object({ assetId: z.string() });

/** Icon per guide kind (string-keyed — Prisma enum values are undefined in
 * the browser build). */
const KIND_ICON: Record<string, typeof LinkIcon> = {
  MANUAL: BookOpenIcon,
  VIDEO: PlayIcon,
  LINK: LinkIcon,
};

/**
 * Lists the asset's guides. Gated `asset:update` — this is a staff CMS tab.
 */
export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { assetId } = getParams(params, paramsSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.update,
    });

    const guides = await listAssetGuides({ organizationId, assetId });

    const header: HeaderData = { title: "Guides" };
    return payload({ header, guides });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, assetId });
    throw data(error(reason), { status: reason.status });
  }
}

/**
 * Adds (`intent=add`) or removes (`intent=delete`) a guide, org-scoped.
 */
export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { assetId } = getParams(params, paramsSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.update,
    });

    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "delete") {
      const { guideId } = parseData(
        formData,
        z.object({ guideId: z.string().min(1) }),
        { shouldBeCaptured: false }
      );
      await deleteAssetGuide({ id: guideId, organizationId });
      return payload({ ok: true });
    }

    const parsed = parseData(formData, AssetGuideSchema, {
      shouldBeCaptured: false,
      additionalData: { userId, assetId, organizationId },
    });

    await createAssetGuide({
      organizationId,
      assetId,
      createdById: userId,
      ...parsed,
    });

    return payload({ ok: true });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, assetId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title) },
];

export const handle = {
  breadcrumb: () => "single",
};

/**
 * The tab: existing guides (with member-visible embed hints) + the add form.
 */
export default function AssetGuidesTab() {
  const { guides } = useLoaderData<typeof loader>();
  const disabled = useDisabled();

  const actionData = useActionData<DataOrErrorResponse>();
  /** Server-side validation fallback (client validation can be bypassed). */
  const validationErrors = getValidationErrors<typeof AssetGuideSchema>(
    actionData?.error
  );

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* Existing guides */}
      <div className="w-full rounded-lg border border-gray-200 bg-white lg:flex-1">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-900">
            Guides members see
          </h3>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
            {guides.length}
          </span>
        </div>

        {guides.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-600">
            No guides yet. Add a manual link or a video explainer — members will
            see it on this item&apos;s info page.
          </div>
        ) : (
          <ul>
            {guides.map((guide) => {
              const kind = String(guide.kind);
              const Icon = KIND_ICON[kind] ?? LinkIcon;
              const embeds = kind === "VIDEO" && videoEmbedUrl(guide.url);
              return (
                <li
                  key={guide.id}
                  className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-900">
                      {guide.title}
                    </p>
                    <a
                      href={guide.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-xs text-gray-400 hover:text-primary-700"
                    >
                      {guide.url}
                    </a>
                    <p className="text-xs text-gray-500">
                      {ASSET_GUIDE_KIND_LABEL[
                        kind as keyof typeof ASSET_GUIDE_KIND_LABEL
                      ] ?? kind}
                      {kind === "VIDEO"
                        ? embeds
                          ? " · will embed as a player"
                          : " · not a YouTube/Vimeo link, shows as a plain link"
                        : ""}
                    </p>
                  </div>
                  <Form method="post" className="shrink-0">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="guideId" value={guide.id} />
                    <Button
                      type="submit"
                      variant="secondary"
                      size="sm"
                      disabled={disabled}
                    >
                      Remove
                    </Button>
                  </Form>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Add a guide */}
      <div className="w-full rounded-lg border border-gray-200 bg-white p-4 lg:w-96">
        <h3 className="mb-3 text-sm font-semibold text-gray-900">
          Add a guide
        </h3>
        <Form method="post" className="flex flex-col gap-3">
          <input type="hidden" name="intent" value="add" />
          <div>
            <label
              htmlFor="guide-kind"
              className="mb-[6px] block text-sm font-medium text-gray-700"
            >
              Type
            </label>
            <select
              id="guide-kind"
              name="kind"
              required
              defaultValue={"MANUAL" satisfies AssetGuideKind}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-300 focus:outline-none focus:ring-1 focus:ring-primary-300"
            >
              {ASSET_GUIDE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {ASSET_GUIDE_KIND_LABEL[kind]}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Title"
            name="title"
            placeholder="e.g. Owner's manual (PDF)"
            required
            error={validationErrors?.title?.message}
          />
          <Input
            label="Link"
            name="url"
            type="url"
            placeholder="https://…"
            required
            error={validationErrors?.url?.message}
          />
          <p className="text-xs text-gray-500">
            YouTube and Vimeo links embed as players on the member page;
            everything else shows as a link.
          </p>
          <Button type="submit" disabled={disabled}>
            {disabled ? "Adding…" : "Add guide"}
          </Button>
        </Form>
      </div>
    </div>
  );
}
