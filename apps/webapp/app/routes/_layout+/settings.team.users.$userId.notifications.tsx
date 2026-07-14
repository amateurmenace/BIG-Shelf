/**
 * User Notifications Tab (admin) — `/settings/team/users/:userId/notifications`
 *
 * BIG-only. Lets an ADMIN/OWNER turn off the booking emails ANOTHER user receives
 * about other people's bookings — the "stop emailing Jessica on every reservation,
 * but keep emailing everyone else" case.
 *
 * The org-level setting (Settings → Bookings → "notify admins on new booking") is
 * all-or-nothing: it silences EVERY admin at once. This is the per-person layer.
 *
 * ## Two userIds, and it matters
 *
 * - `params.userId` — the TARGET user whose settings are being edited.
 * - `authSession.userId` — the ACTING admin.
 *
 * `organizationId` always comes from the acting admin's `requirePermission`, never
 * from the request, so an admin can only ever edit preferences inside a workspace
 * they actually administer. The target user is verified to be a member of that
 * same workspace before anything is written.
 *
 * @see {@link file://./account-details.notifications.tsx} — where a user edits their own
 * @see {@link file://./../../modules/big-notification-prefs/service.server.ts}
 */
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useLoaderData } from "react-router";
import { z } from "zod";
import { NotificationPreferencesForm } from "~/components/big/notification-preferences-form";
import type { HeaderData } from "~/components/layout/header/types";
import { db } from "~/database/db.server";
import {
  getNotificationPreferences,
  upsertNotificationPreferences,
} from "~/modules/big-notification-prefs/service.server";
import {
  NotificationPreferencesSchema,
  UPDATE_NOTIFICATION_PREFERENCES_INTENT,
} from "~/modules/big-notification-prefs/shared";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, getParams, parseData, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const paramsSchema = z.object({ userId: z.string() });

/**
 * Confirms the target user actually belongs to the admin's workspace, and returns
 * their name for the UI.
 *
 * Without this, a `userId` from the URL would be written straight into a
 * preference row scoped to the caller's org — a cross-workspace write driven by
 * request input. Org-scope every user-supplied id before using it.
 *
 * @param args.targetUserId - The user id from the URL
 * @param args.organizationId - The acting admin's workspace
 * @returns The target user's name
 * @throws {ShelfError} 404 when the user isn't a member of this workspace
 */
async function requireUserInOrg({
  targetUserId,
  organizationId,
}: {
  targetUserId: string;
  organizationId: string;
}) {
  const membership = await db.userOrganization.findFirst({
    where: { userId: targetUserId, organizationId },
    select: { user: { select: { firstName: true, lastName: true } } },
  });

  if (!membership) {
    throw new ShelfError({
      cause: null,
      message: "User not found in this workspace",
      status: 404,
      additionalData: { targetUserId, organizationId },
      label: "Settings",
      shouldBeCaptured: false,
    });
  }

  return membership.user;
}

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  /** The user whose settings we're loading — NOT the acting admin. */
  const { userId: targetUserId } = getParams(params, paramsSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.teamMemberProfile,
      action: PermissionAction.read,
    });

    const user = await requireUserInOrg({ targetUserId, organizationId });

    const preferences = await getNotificationPreferences({
      userId: targetUserId,
      organizationId,
    });

    const header: HeaderData = { title: "Notifications" };

    return payload({
      header,
      preferences,
      subjectLabel: user.firstName || user.lastName || "this user",
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { targetUserId, userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request, params }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  const { userId: targetUserId } = getParams(params, paramsSchema, {
    additionalData: { userId },
  });

  try {
    // teamMember:update is the admin gate — BASE/SELF_SERVICE/MEMBER don't hold it.
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.teamMember,
      action: PermissionAction.update,
    });

    await requireUserInOrg({ targetUserId, organizationId });

    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent !== UPDATE_NOTIFICATION_PREFERENCES_INTENT) {
      throw new ShelfError({
        cause: null,
        message: "Unsupported action",
        additionalData: { intent },
        label: "Settings",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    const preferences = parseData(formData, NotificationPreferencesSchema);

    const saved = await upsertNotificationPreferences({
      userId: targetUserId,
      organizationId,
      preferences,
    });

    return payload({ preferences: saved });
  } catch (cause) {
    const reason = makeShelfError(cause, { targetUserId, userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = { name: "$userId.notifications" };

export default function UserNotificationSettings() {
  const { preferences, subjectLabel } = useLoaderData<typeof loader>();

  return (
    <NotificationPreferencesForm
      preferences={preferences}
      subjectLabel={subjectLabel}
    />
  );
}
