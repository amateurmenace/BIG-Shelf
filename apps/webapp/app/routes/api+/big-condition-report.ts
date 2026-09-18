/**
 * BIG Condition Report API — `/api/big-condition-report`
 *
 * Files a condition entry (note, grade, optional photo) against one asset and
 * answers with JSON rather than a redirect, so it can be called from a fetcher
 * inside another screen — specifically the check-in wizard, where staff
 * photograph a problem the moment they spot it without leaving the scan flow.
 *
 * The asset page's own condition tab keeps its redirect-style action; this is
 * the same service (`createConditionEntryFromRequest`) with a JSON envelope.
 *
 * The request is multipart (the photo), so `assetId` arrives as a form FIELD
 * rather than a route param — it is validated against the caller's organization
 * before anything is written.
 *
 * BIG-only additive route.
 *
 * @see {@link file://./../../modules/big-asset-condition/service.server.ts}
 * @see {@link file://./../_layout+/check-in.tsx}
 */
import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { db } from "~/database/db.server";
import { createConditionEntryFromRequest } from "~/modules/big-asset-condition/service.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.update,
    });

    /**
     * `assetId` rides in the URL query, not the multipart body: the body can
     * only be read once (the parser consumes it while streaming the photo to
     * storage), and it must be validated BEFORE that upload happens.
     * @see .claude/rules/org-scope-user-supplied-ids.md
     */
    const assetId = new URL(request.url).searchParams.get("assetId");

    if (!assetId) {
      throw new ShelfError({
        cause: null,
        message: "No asset was specified for this condition report.",
        additionalData: { userId, organizationId },
        status: 400,
        shouldBeCaptured: false,
        label: "Asset Condition",
      });
    }

    const asset = await db.asset.findFirst({
      where: { id: assetId, organizationId },
      select: { id: true, title: true },
    });

    if (!asset) {
      throw new ShelfError({
        cause: null,
        message: "That item doesn't exist in this workspace.",
        additionalData: { userId, organizationId, assetId },
        status: 404,
        shouldBeCaptured: false,
        label: "Asset Condition",
      });
    }

    await createConditionEntryFromRequest({
      request,
      assetId: asset.id,
      organizationId,
      createdById: userId,
    });

    return payload({
      ok: true as const,
      assetId: asset.id,
      title: asset.title,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
