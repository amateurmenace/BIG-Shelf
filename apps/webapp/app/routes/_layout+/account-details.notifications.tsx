/**
 * My email notifications — `/account-details/notifications`
 *
 * BIG-only. Lets a person turn off the booking emails they receive about OTHER
 * people's bookings, per workspace.
 *
 * Before this, the only controls were org-level and all-or-nothing (Settings →
 * Bookings): "notify admins on new booking" mailed EVERY admin on EVERY
 * reservation, and the only way to stop mailing one person was to stop mailing
 * the whole team.
 *
 * Scope note: these toggles govern only notifications received because the person
 * is an admin or on the always-notify list. Emails about a booking they hold or
 * created — overdue notices included — always send. See the module doc in
 * `big-notification-prefs/service.server.ts`.
 *
 * Gated on `userData:read` / `userData:update` — the permission every role holds
 * "for the user to load their own data". The subject is ALWAYS the signed-in user
 * (`context.getSession()`), never anything from the request, so this route cannot
 * be used to edit somebody else.
 *
 * @see {@link file://./settings.team.users.$userId.notifications.tsx} — the admin equivalent
 * @see {@link file://./../../modules/big-notification-prefs/service.server.ts}
 */
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useLoaderData } from "react-router";
import { NotificationPreferencesForm } from "~/components/big/notification-preferences-form";
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
import { error, parseData, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  // The subject is the signed-in user, full stop.
  const { userId } = context.getSession();

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.userData,
      action: PermissionAction.read,
    });

    const preferences = await getNotificationPreferences({
      userId,
      organizationId,
    });

    return payload({ title: "Notifications", preferences });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.userData,
      action: PermissionAction.update,
    });

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
      userId,
      organizationId,
      preferences,
    });

    return payload({ preferences: saved });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: appendToMetaTitle(data?.title) },
];

export const handle = { breadcrumb: () => "Notifications" };

export default function MyNotificationSettings() {
  const { preferences } = useLoaderData<typeof loader>();

  return <NotificationPreferencesForm preferences={preferences} />;
}
