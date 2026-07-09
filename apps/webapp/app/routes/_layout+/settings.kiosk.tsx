/**
 * Kiosk display (admin CMS) — `/settings/kiosk`
 *
 * BIG-only. The content-management page for the public `/kiosk` wallboard:
 * - **Class & event promos** — up to three cards (image + title + date +
 *   sign-up link). The wallboard renders each with a QR code so visitors sign
 *   up on their phone.
 * - **Membership sign-up card** — the welcoming "become a member" panel:
 *   headline, blurb, and the sign-up URL its QR code points at. The card
 *   shows on the wall only once a URL is set.
 * - **Closed days** — read-only preview. The kiosk's month calendar derives
 *   closures from the org's Working Hours (weekly schedule + date
 *   overrides), managed under Settings → Bookings, so booking validation and
 *   the wallboard always agree.
 *
 * Gated on `generalSettings` (ADMIN/OWNER) in a TEAM workspace, mirroring the
 * Room calendar settings page.
 *
 * @see {@link file://./../../modules/big-kiosk-content/service.server.ts}
 * @see {@link file://./../kiosk.tsx} — the wallboard this feeds
 */
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import { z } from "zod";
import Input from "~/components/forms/input";
import { Button } from "~/components/shared/button";
import { formatAbsoluteDate } from "~/components/shared/date";
import { useDisabled } from "~/hooks/use-disabled";
import {
  createKioskPromoFromRequest,
  deleteKioskPromo,
  getKioskClosedDays,
  getKioskConfig,
  getKioskPromos,
  upsertKioskConfig,
} from "~/modules/big-kiosk-content/service.server";
// From the client-safe shared file: the component itself renders with these,
// so they must not come from the .server module (vite excludes it from the
// client bundle and the route would fail to load).
import {
  KioskMembershipSchema,
  MAX_KIOSK_PROMOS,
} from "~/modules/big-kiosk-content/shared";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { getValidationErrors } from "~/utils/http";
import { error, parseData, payload } from "~/utils/http.server";
import type { DataOrErrorResponse } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/** JS weekday index → display name, for the weekly-closures summary. */
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * The kiosk is TEAM infrastructure (a wall display for the space). Personal
 * workspaces must not configure one.
 *
 * @throws {ShelfError} 403 when the selected workspace isn't a TEAM org
 */
function assertTeamWorkspace(organizationType: string): void {
  if (organizationType !== "TEAM") {
    throw new ShelfError({
      cause: null,
      title: "Not available in this workspace",
      message:
        "The kiosk display is only available to admins of a team workspace.",
      label: "Kiosk",
      status: 403,
      shouldBeCaptured: false,
    });
  }
}

/**
 * Loads everything the CMS shows: promos, membership-card config, and the
 * derived closed-days preview.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();

  try {
    const { organizationId, currentOrganization } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.read,
    });
    assertTeamWorkspace(currentOrganization.type);

    const [promos, config, closedDays] = await Promise.all([
      getKioskPromos({ organizationId }),
      getKioskConfig({ organizationId }),
      getKioskClosedDays({ organizationId }),
    ]);

    return data(
      payload({
        header: { title: "Kiosk display" },
        promos,
        config,
        closedDays,
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

/**
 * Handles the three CMS mutations. The add-promo form is multipart (it
 * carries the image), so the action branches on content type BEFORE reading
 * the body: multipart → create promo; urlencoded → `delete-promo` /
 * `save-membership` intents.
 */
export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();

  try {
    const { organizationId, currentOrganization } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.update,
    });
    assertTeamWorkspace(currentOrganization.type);

    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      await createKioskPromoFromRequest({
        request,
        organizationId,
        createdById: userId,
      });

      sendNotification({
        title: "Promo added",
        message: "The kiosk will show it within a minute.",
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });
      return payload({ ok: true });
    }

    const formData = await request.formData();
    const { intent } = parseData(
      formData,
      z.object({ intent: z.enum(["delete-promo", "save-membership"]) }),
      { additionalData: { userId, organizationId } }
    );

    switch (intent) {
      case "delete-promo": {
        const { promoId } = parseData(
          formData,
          z.object({ promoId: z.string().min(1) }),
          { additionalData: { userId, organizationId } }
        );
        await deleteKioskPromo({ id: promoId, organizationId });

        sendNotification({
          title: "Promo removed",
          message: "The kiosk will drop it within a minute.",
          icon: { name: "trash", variant: "error" },
          senderId: userId,
        });
        return payload({ ok: true });
      }

      case "save-membership": {
        const parsed = parseData(formData, KioskMembershipSchema, {
          additionalData: { userId, organizationId },
          shouldBeCaptured: false,
        });
        await upsertKioskConfig({
          organizationId,
          updatedById: userId,
          ...parsed,
        });

        sendNotification({
          title: "Membership card saved",
          message: parsed.membershipSignupUrl
            ? "The kiosk now invites visitors to join."
            : "The card is hidden until you set a sign-up link.",
          icon: { name: "success", variant: "success" },
          senderId: userId,
        });
        return payload({ ok: true });
      }
    }
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title) },
];

export const handle = {
  name: "settings.kiosk",
};

/**
 * The CMS page: promos manager, membership-card editor, closed-days preview.
 */
export default function KioskSettingsPage() {
  const { promos, config, closedDays } = useLoaderData<typeof loader>();
  const actionData = useActionData<DataOrErrorResponse>();
  const disabled = useDisabled();

  /** Server-side validation fallback for the membership form. */
  const validationErrors = getValidationErrors<typeof KioskMembershipSchema>(
    actionData?.error
  );
  const topLevelError =
    actionData?.error && !validationErrors ? actionData.error : null;

  const slotsLeft = MAX_KIOSK_PROMOS - promos.length;

  return (
    <div className="flex flex-col gap-4 pb-8">
      {/* Intro */}
      <div className="flex flex-col justify-between gap-3 rounded border border-gray-200 bg-white p-4 md:flex-row md:items-center md:p-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Kiosk display</h2>
          <p className="text-sm text-gray-500">
            What the lobby wallboard shows besides the live room schedule: class
            &amp; event promos, the membership invitation, and the days
            you&apos;re closed.
          </p>
        </div>
        <Button to="/kiosk" target="_blank" variant="secondary">
          Open wallboard
        </Button>
      </div>

      {topLevelError ? (
        <div
          role="alert"
          className="rounded border border-error-200 bg-error-50 p-3 text-sm text-error-700"
        >
          <p className="font-medium">
            {topLevelError.title ?? "Something went wrong"}
          </p>
          <p>{topLevelError.message}</p>
        </div>
      ) : null}

      {/* Promos */}
      <div className="rounded border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3 md:px-6">
          <h3 className="text-sm font-semibold text-gray-900">
            Class &amp; event promos
          </h3>
          <p className="text-xs text-gray-500">
            Up to {MAX_KIOSK_PROMOS} cards on the wallboard, each with a QR code
            visitors scan to sign up. {slotsLeft} slot
            {slotsLeft === 1 ? "" : "s"} left.
          </p>
        </div>

        {promos.length > 0 ? (
          <ul className="divide-y divide-gray-100">
            {promos.map((promo) => (
              <li
                key={promo.id}
                className="flex items-center gap-4 px-4 py-3 md:px-6"
              >
                <img
                  src={promo.imageUrl}
                  alt=""
                  className="h-14 w-24 shrink-0 rounded object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-900">
                    {promo.title}
                  </p>
                  <p className="truncate text-xs text-gray-500">
                    {promo.eventDate
                      ? `${formatAbsoluteDate(promo.eventDate, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })} · `
                      : ""}
                    {promo.linkUrl}
                  </p>
                </div>
                <Form method="post" className="shrink-0">
                  <input type="hidden" name="intent" value="delete-promo" />
                  <input type="hidden" name="promoId" value={promo.id} />
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
            ))}
          </ul>
        ) : (
          <p className="p-4 text-sm text-gray-500 md:px-6">
            No promos yet — add your first class or event below.
          </p>
        )}

        {slotsLeft > 0 ? (
          <Form
            method="post"
            encType="multipart/form-data"
            className="flex flex-col gap-3 border-t border-gray-100 p-4 md:p-6"
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Input
                label="Title"
                name="title"
                placeholder="Intro to Podcasting"
                required
              />
              <Input
                label="Event date (optional)"
                type="date"
                name="eventDate"
              />
            </div>
            <Input
              label="Sign-up link"
              name="linkUrl"
              type="url"
              placeholder="https://…"
              required
            />
            <div>
              <label
                htmlFor="kiosk-promo-image"
                className="mb-[6px] block text-sm font-medium text-gray-700"
              >
                Image
              </label>
              <input
                id="kiosk-promo-image"
                type="file"
                name="image"
                accept="image/png,image/jpeg,image/webp"
                required
                className="block w-full text-sm text-gray-600 file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200"
              />
              <p className="mt-1 text-xs text-gray-500">
                Landscape images look best on the wall (about 3:2). JPG, PNG or
                WebP.
              </p>
            </div>
            <div>
              <Button type="submit" disabled={disabled}>
                {disabled ? "Adding…" : "Add promo"}
              </Button>
            </div>
          </Form>
        ) : null}
      </div>

      {/* Membership card */}
      <div className="rounded border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3 md:px-6">
          <h3 className="text-sm font-semibold text-gray-900">
            Membership sign-up card
          </h3>
          <p className="text-xs text-gray-500">
            The warm &ldquo;come join us&rdquo; panel on the wallboard, with a
            QR code to your membership page. It appears once a sign-up link is
            set.
          </p>
        </div>
        <Form method="post" className="flex flex-col gap-3 p-4 md:p-6">
          <input type="hidden" name="intent" value="save-membership" />
          <Input
            label="Headline"
            name="membershipHeadline"
            defaultValue={config?.membershipHeadline ?? ""}
            placeholder="Become a BIG member"
            error={validationErrors?.membershipHeadline?.message}
          />
          <Input
            label="Welcome message"
            inputType="textarea"
            rows={3}
            name="membershipBlurb"
            defaultValue={config?.membershipBlurb ?? ""}
            placeholder="Everyone's welcome here! Members borrow cameras and gear, book our studios, and join classes — scan to become part of the BIG community."
            error={validationErrors?.membershipBlurb?.message}
          />
          <Input
            label="Sign-up link"
            name="membershipSignupUrl"
            type="url"
            defaultValue={config?.membershipSignupUrl ?? ""}
            placeholder="https://…"
            error={validationErrors?.membershipSignupUrl?.message}
          />
          <div>
            <Button type="submit" disabled={disabled}>
              {disabled ? "Saving…" : "Save membership card"}
            </Button>
          </div>
        </Form>
      </div>

      {/* Closed days (read-only, sourced from Working Hours) */}
      <div className="rounded border border-gray-200 bg-white">
        <div className="flex flex-col justify-between gap-3 border-b border-gray-100 px-4 py-3 md:flex-row md:items-center md:px-6">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Closed days</h3>
            <p className="text-xs text-gray-500">
              The kiosk&apos;s month calendar marks these automatically from
              your Working hours — one source of truth with booking rules.
            </p>
          </div>
          <Button to="/settings/bookings" variant="secondary" size="sm">
            Manage in Booking settings
          </Button>
        </div>
        <div className="p-4 text-sm text-gray-700 md:p-6">
          {!closedDays.enabled ? (
            <p className="text-gray-500">
              Working hours are off, so the kiosk shows no closed days. Turn
              them on in Booking settings to mark weekly closures and holidays.
            </p>
          ) : (
            <>
              <p>
                <span className="font-medium">Closed every week:</span>{" "}
                {closedDays.weeklyClosedWeekdays.length > 0
                  ? closedDays.weeklyClosedWeekdays
                      .map((weekday) => WEEKDAY_NAMES[weekday])
                      .join(", ")
                  : "none"}
              </p>
              <p className="mt-2 font-medium">Upcoming closures:</p>
              {closedDays.closedOverrides.length > 0 ? (
                <ul className="mt-1 list-inside list-disc text-gray-600">
                  {closedDays.closedOverrides.map((override) => (
                    <li key={override.date}>
                      {formatAbsoluteDate(override.date, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                      {override.reason ? ` — ${override.reason}` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-gray-500">
                  None scheduled in the next two months.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
