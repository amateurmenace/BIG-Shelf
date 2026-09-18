/**
 * Settings → Team → Users → [user] → Profile
 *
 * The admin view of one member's account: their contact details (editable), and
 * a password reset they can trigger on the member's behalf.
 *
 * BIG: there was previously no admin-side way to help someone who could not get
 * into their account — the only path was the self-service "forgot password"
 * flow, and when that silently failed to deliver (see
 * {@link sendResetPasswordLink}) staff had nothing to offer. Sending the code
 * from here uses the same corrected path, with the email saying who started it
 * so an unexpected code does not read as an attack.
 *
 * Deliberately NOT here: setting a password directly. Staff should never know a
 * member's password, and a code the member redeems themselves keeps that true.
 *
 * Gated on `teamMember:update` — the same permission as the notifications tab.
 *
 * @see {@link file://./settings.team.users.$userId.tsx} — the tab list
 * @see {@link file://./../../modules/auth/service.server.ts} — sendResetPasswordLink
 */
import type { Prisma } from "@prisma/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useActionData, useLoaderData } from "react-router";
import { z } from "zod";
import { Form } from "~/components/custom-form";
import { ErrorContent } from "~/components/errors";
import Input from "~/components/forms/input";
import { Button } from "~/components/shared/button";
import { Card } from "~/components/shared/card";
import { DateS } from "~/components/shared/date";
import { useDisabled } from "~/hooks/use-disabled";
import { sendResetPasswordLink } from "~/modules/auth/service.server";
import {
  getUserByID,
  getUserFromOrg,
  updateUser,
} from "~/modules/user/service.server";
import { updateUserContact } from "~/modules/user-contact/service.server";
import { getUserContactById } from "~/modules/user-contact/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { getValidationErrors } from "~/utils/http";
import type { DataOrErrorResponse } from "~/utils/http.server";
import { error, getParams, parseData, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { resolveUserDisplayName } from "~/utils/user";

export const meta = () => [{ title: appendToMetaTitle("User profile") }];

export const handle = { name: "$userId.profile" };

/** Editable identity fields. */
const ProfileSchema = z.object({
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(40).optional(),
  street: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  stateProvince: z.string().trim().max(100).optional(),
  zipPostalCode: z.string().trim().max(30).optional(),
  countryRegion: z.string().trim().max(100).optional(),
});

/** Which button on the page was pressed. */
const IntentSchema = z.object({
  intent: z.enum(["updateProfile", "sendPasswordReset"]),
});

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, userOrganizations } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.teamMemberProfile,
      action: PermissionAction.read,
    });

    const { userId: selectedUserId } = getParams(
      params,
      z.object({ userId: z.string() }),
      { additionalData: { userId } }
    );

    // Org-scoped: getUserFromOrg only resolves a user who shares an org with
    // the caller, so a user id from another workspace cannot be read here.
    const user = await getUserFromOrg({
      id: selectedUserId,
      organizationId,
      userOrganizations,
      request,
    });

    const contact = await getUserContactById(selectedUserId);

    return payload({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        displayName: user.displayName,
        createdAt: user.createdAt,
        sso: user.sso,
      },
      contact,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, userOrganizations } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.teamMember,
      action: PermissionAction.update,
    });

    const { userId: selectedUserId } = getParams(
      params,
      z.object({ userId: z.string() }),
      { additionalData: { userId } }
    );

    /**
     * Prove the target user shares an organization with the caller BEFORE
     * writing anything — `selectedUserId` comes from the URL.
     * @see .claude/rules/org-scope-user-supplied-ids.md
     */
    const target = await getUserFromOrg({
      id: selectedUserId,
      organizationId,
      userOrganizations,
    });

    const formData = await request.formData();
    const { intent } = parseData(formData, IntentSchema, {
      additionalData: { userId, selectedUserId },
    });

    switch (intent) {
      case "updateProfile": {
        const profile = parseData(formData, ProfileSchema, {
          additionalData: { userId, selectedUserId },
          shouldBeCaptured: false,
        });

        await updateUser({
          id: target.id,
          firstName: profile.firstName,
          lastName: profile.lastName,
        });

        await updateUserContact({
          userId: target.id,
          phone: profile.phone ?? "",
          street: profile.street ?? "",
          city: profile.city ?? "",
          stateProvince: profile.stateProvince ?? "",
          zipPostalCode: profile.zipPostalCode ?? "",
          countryRegion: profile.countryRegion ?? "",
        });

        sendNotification({
          title: "Profile updated",
          message: "Their details have been saved.",
          icon: { name: "success", variant: "success" },
          senderId: userId,
        });

        return payload({ success: true });
      }

      case "sendPasswordReset": {
        if (target.sso) {
          throw new ShelfError({
            cause: null,
            title: "Managed by SSO",
            message:
              "This account signs in through your identity provider, so its password is managed there — not in Shelf.",
            additionalData: { userId, selectedUserId },
            status: 400,
            shouldBeCaptured: false,
            label: "Auth",
          });
        }

        const admin = await getUserByID(userId, {
          select: {
            firstName: true,
            lastName: true,
            displayName: true,
          } satisfies Prisma.UserSelect,
        });

        await sendResetPasswordLink(target.email, {
          initiatedByAdmin: true,
          adminName: resolveUserDisplayName(admin),
        });

        sendNotification({
          title: "Reset code sent",
          message: `We've emailed a reset code to ${target.email}.`,
          icon: { name: "success", variant: "success" },
          senderId: userId,
        });

        return payload({ success: true });
      }
    }
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export default function UserProfileTab() {
  const { user, contact } = useLoaderData<typeof loader>();
  const actionData = useActionData<DataOrErrorResponse>();
  const disabled = useDisabled();
  /** Server-side errors, shown as a fallback when client validation differs. */
  const validationErrors = getValidationErrors<typeof ProfileSchema>(
    actionData?.error
  );

  return (
    <div className="mb-6 flex flex-col gap-4 lg:flex-row">
      <Card className="my-0 lg:w-2/3">
        <h3 className="mb-1 text-text-lg font-semibold">Contact details</h3>
        <p className="mb-4 text-sm text-gray-600">
          Members can edit these themselves under Account details. Changing them
          here is for when they ask you to.
        </p>

        <Form method="post" className="flex flex-col gap-3">
          <input type="hidden" name="intent" value="updateProfile" />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label="First name"
              name="firstName"
              defaultValue={user.firstName ?? ""}
              error={validationErrors?.firstName?.message}
              className="w-full"
              inputClassName="w-full"
            />
            <Input
              label="Last name"
              name="lastName"
              defaultValue={user.lastName ?? ""}
              error={validationErrors?.lastName?.message}
              className="w-full"
              inputClassName="w-full"
            />
          </div>

          <Input
            label="Phone"
            name="phone"
            defaultValue={contact?.phone ?? ""}
            error={validationErrors?.phone?.message}
            className="w-full"
            inputClassName="w-full"
          />
          <Input
            label="Street"
            name="street"
            defaultValue={contact?.street ?? ""}
            className="w-full"
            inputClassName="w-full"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input
              label="City"
              name="city"
              defaultValue={contact?.city ?? ""}
              className="w-full"
              inputClassName="w-full"
            />
            <Input
              label="State / province"
              name="stateProvince"
              defaultValue={contact?.stateProvince ?? ""}
              className="w-full"
              inputClassName="w-full"
            />
            <Input
              label="ZIP / postcode"
              name="zipPostalCode"
              defaultValue={contact?.zipPostalCode ?? ""}
              className="w-full"
              inputClassName="w-full"
            />
          </div>
          <Input
            label="Country / region"
            name="countryRegion"
            defaultValue={contact?.countryRegion ?? ""}
            className="w-full"
            inputClassName="w-full"
          />

          <div>
            <Button type="submit" disabled={disabled}>
              {disabled ? "Saving..." : "Save details"}
            </Button>
          </div>
        </Form>
      </Card>

      <div className="flex flex-col gap-4 lg:w-1/3">
        <Card className="my-0">
          <h3 className="mb-1 text-text-lg font-semibold">Account</h3>
          <dl className="mb-4 text-sm">
            <div className="flex justify-between border-b border-gray-100 py-2">
              <dt className="text-gray-500">Email</dt>
              <dd className="truncate font-medium text-gray-900">
                {user.email}
              </dd>
            </div>
            <div className="flex justify-between py-2">
              <dt className="text-gray-500">Member since</dt>
              <dd className="font-medium text-gray-900">
                <DateS date={user.createdAt} />
              </dd>
            </div>
          </dl>
        </Card>

        <Card className="my-0">
          <h3 className="mb-1 text-text-lg font-semibold">Password</h3>
          {user.sso ? (
            <p className="text-sm text-gray-600">
              This account signs in through your identity provider, so its
              password is managed there.
            </p>
          ) : (
            <>
              <p className="mb-3 text-sm text-gray-600">
                Emails a one-time reset code to{" "}
                <span className="font-medium text-gray-900">{user.email}</span>.
                The email says you started it, so the code is not mistaken for
                an attack. You never see or set their password.
              </p>
              <Form method="post">
                <input type="hidden" name="intent" value="sendPasswordReset" />
                <Button type="submit" variant="secondary" disabled={disabled}>
                  {disabled ? "Sending..." : "Send password reset code"}
                </Button>
              </Form>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
