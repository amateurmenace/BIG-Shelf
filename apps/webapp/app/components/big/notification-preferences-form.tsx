/**
 * Booking-email preferences form (BIG)
 *
 * The toggle pair shared by BOTH surfaces that edit these preferences:
 *  - a person editing their own (`/account-details/notifications`)
 *  - an admin editing someone else's (Settings → Team → Users → Notifications)
 *
 * Both post to their OWN route (no `action` prop), so this component doesn't care
 * whose preferences it's editing — the route's action decides that from its own
 * permission check, never from anything this form submits. That's deliberate: an
 * admin-only field must never be settable by whatever a form posts.
 *
 * Toggles auto-submit on change, matching the org-level notification settings
 * (`~/components/booking/notification-settings.tsx`).
 *
 * @see {@link file://./../../modules/big-notification-prefs/shared.ts}
 */
import { useFetcher } from "react-router";
import FormRow from "~/components/forms/form-row";
import { Switch } from "~/components/forms/switch";
import { Card } from "~/components/shared/card";
import { useDisabled } from "~/hooks/use-disabled";
import type { NotificationPreferences } from "~/modules/big-notification-prefs/shared";
import { UPDATE_NOTIFICATION_PREFERENCES_INTENT } from "~/modules/big-notification-prefs/shared";

/**
 * @param preferences - The current saved preferences (defaults when never set)
 * @param subjectLabel - Whose settings these are, for the copy. Omit for "you";
 *   pass a first name when an admin is editing someone else.
 */
export function NotificationPreferencesForm({
  preferences,
  subjectLabel,
}: {
  preferences: NotificationPreferences;
  subjectLabel?: string;
}) {
  const fetcher = useFetcher();
  const disabled = useDisabled(fetcher);

  // "you" vs "Jessica" — the same switches serve both surfaces.
  const who = subjectLabel ?? "you";
  const possessive = subjectLabel ? `${subjectLabel}’s` : "your";

  return (
    <Card className="mt-0">
      <div className="mb-4 border-b pb-4">
        <h3 className="text-text-lg font-semibold">Booking emails</h3>
        <p className="text-sm text-gray-600">
          Which emails {who} get about <strong>other people’s</strong> bookings.
          Emails about bookings {who} personally hold or created are always sent
          — including overdue notices — so {possessive} own late returns can’t
          be missed.
        </p>
      </div>

      <fetcher.Form
        method="post"
        onChange={(event) => fetcher.submit(event.currentTarget)}
      >
        <input
          type="hidden"
          name="intent"
          value={UPDATE_NOTIFICATION_PREFERENCES_INTENT}
        />

        <FormRow
          rowLabel="New reservations"
          subHeading={
            <p>
              Email {who} every time someone else reserves equipment or a room.
            </p>
          }
          className="border-b-0 pb-[10px] pt-0"
        >
          <div className="flex flex-col items-center gap-2">
            <Switch
              name="notifyOnReservation"
              defaultChecked={preferences.notifyOnReservation}
              disabled={disabled}
              aria-label="Email me when someone else reserves"
            />
          </div>
        </FormRow>

        <FormRow
          rowLabel="Overdue bookings"
          subHeading={
            <p>
              Email {who} when someone else’s booking becomes late. (Overdue
              notices for {possessive} own bookings are always sent.)
            </p>
          }
          className="border-b-0 pb-[10px] pt-0"
        >
          <div className="flex flex-col items-center gap-2">
            <Switch
              name="notifyOnOverdue"
              defaultChecked={preferences.notifyOnOverdue}
              disabled={disabled}
              aria-label="Email me when someone else's booking is overdue"
            />
          </div>
        </FormRow>
      </fetcher.Form>
    </Card>
  );
}
