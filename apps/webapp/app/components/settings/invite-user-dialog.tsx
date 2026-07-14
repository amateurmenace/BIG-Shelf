import type { ReactElement } from "react";
import { cloneElement, useCallback, useEffect, useRef, useState } from "react";
import { OrganizationRoles } from "@prisma/client";
import { UserIcon } from "lucide-react";
import { useFetcher } from "react-router";
import { useZorm } from "react-zorm";
import { z } from "zod";
import { useCurrentOrganization } from "~/hooks/use-current-organization";
import useFetcherWithReset from "~/hooks/use-fetcher-with-reset";
import type { UserFriendlyRoles } from "~/routes/_layout+/settings.team";
import type { loader as membershipCheckLoader } from "~/routes/api+/big-membership-check";
import { isFormProcessing } from "~/utils/form";
import { getValidationErrors } from "~/utils/http";
import type { DataOrErrorResponse } from "~/utils/http.server";
import { validEmail } from "~/utils/misc";
import Input from "../forms/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../forms/select";
import { Dialog, DialogPortal } from "../layout/dialog";
import { Button } from "../shared/button";
import { Image } from "../shared/image";
import When from "../when/when";

type InviteUserDialogProps = {
  className?: string;
  teamMemberId?: string;
  trigger?: ReactElement<{ onClick: () => void }>;
  open?: boolean;
  onClose?: () => void;
};

export const InviteUserFormSchema = z.object({
  email: z
    .string()
    .transform((email) => email.toLowerCase())
    .refine(validEmail, () => ({
      message: "Please enter a valid email",
    })),
  teamMemberId: z.string().optional(),
  role: z.preprocess(
    (value) => String(value).trim().toUpperCase(),
    z.enum(
      [
        OrganizationRoles.ADMIN,
        OrganizationRoles.BASE,
        OrganizationRoles.MEMBER,
        OrganizationRoles.SELF_SERVICE,
      ],
      { message: "Please select a role" }
    )
  ),
  inviteMessage: z.string().max(1000).optional(),
  // BIG: when ticked, the invitee bypasses the active-Neon-membership check and
  // can reserve without a membership (staff, volunteers, partners). Unchecked
  // checkboxes submit nothing, so absence → false.
  membershipCheckExempt: z
    .string()
    .optional()
    .transform((value) => value === "on"),
});

const organizationRolesMap: Record<string, UserFriendlyRoles> = {
  [OrganizationRoles.ADMIN]: "Administrator",
  [OrganizationRoles.BASE]: "Base",
  [OrganizationRoles.MEMBER]: "Member",
  [OrganizationRoles.SELF_SERVICE]: "Self service",
};

/**
 * BIG: inline verdict on whether the invitee can actually reserve.
 *
 * Deliberately a WARNING, not a block — staff have good reasons to invite ahead
 * of a membership purchase. It exists so the failure surfaces here, to the person
 * who can fix it, rather than to the invitee at the last step of a booking.
 *
 * "unknown" (Neon unreachable) is shown neutrally: not being able to check must
 * never be presented as "not a member".
 */
function MembershipWarning({
  state,
  name,
}: {
  state?: "active" | "inactive" | "unknown" | "unconfigured";
  name?: string | null;
}) {
  if (!state || state === "unconfigured") {
    return null;
  }

  if (state === "active") {
    return (
      <p className="text-[13px] text-success-600">
        ✓ Active BIG member{name ? ` (${name})` : ""} — they’ll be able to
        reserve.
      </p>
    );
  }

  if (state === "unknown") {
    return (
      <p className="text-[13px] text-gray-500">
        Couldn’t reach Neon to check this membership. The invite will still
        send.
      </p>
    );
  }

  return (
    <div className="rounded border border-[#FFE082] bg-[#FFF8E1] px-3 py-2 text-[13px] text-gray-700">
      <span className="font-medium">Not an active BIG member.</span> They can
      sign in, but they’ll be blocked when they try to reserve. Tick{" "}
      <span className="font-medium">“Doesn’t require a BIG membership”</span>{" "}
      above to let them reserve anyway.
    </div>
  );
}

export default function InviteUserDialog({
  className,
  trigger,
  teamMemberId,
  open = false,
  onClose,
}: InviteUserDialogProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [messageCharCount, setMessageCharCount] = useState(0);
  const organization = useCurrentOrganization();

  const fetcher =
    useFetcherWithReset<DataOrErrorResponse<{ success?: boolean }>>();

  const disabled = isFormProcessing(fetcher.state);

  const zo = useZorm("NewQuestionWizardScreen", InviteUserFormSchema);

  /**
   * BIG: inviting a MEMBER runs no Neon check, so staff could invite someone who
   * signs in happily and is then refused at "Reserve". Check the email as soon as
   * we know both the role and the address, and warn before the invite goes out.
   */
  const [role, setRole] = useState<string>("");
  const [isExempt, setIsExempt] = useState(false);
  const [email, setEmail] = useState("");
  const membershipCheck = useFetcher<typeof membershipCheckLoader>();

  const needsMembership = role === OrganizationRoles.MEMBER && !isExempt;
  const normalizedEmail = email.trim().toLowerCase();
  const shouldCheck = needsMembership && validEmail(normalizedEmail);

  // Fires on email blur AND when the role is switched to Member afterwards. The
  // ref makes it idempotent: without it, the fetcher's changing identity would
  // re-run the effect and re-request the same email in a loop.
  const lastChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!shouldCheck || lastChecked.current === normalizedEmail) {
      return;
    }
    lastChecked.current = normalizedEmail;
    void membershipCheck.load(
      `/api/big-membership-check?email=${encodeURIComponent(normalizedEmail)}`
    );
  }, [shouldCheck, normalizedEmail, membershipCheck]);

  // `payload()` always sets `error: null`, so the key is present on BOTH the
  // success and failure shapes — narrow on its VALUE, not its presence.
  const check =
    membershipCheck.data && !membershipCheck.data.error
      ? membershipCheck.data
      : undefined;
  // Only warn while the answer still describes what's on screen (the admin may
  // have since ticked "exempt" or changed the role).
  const membershipWarning = shouldCheck ? check?.state : undefined;

  /** Handle server-side validation errors as fallback */
  const validationErrors = getValidationErrors<typeof InviteUserFormSchema>(
    fetcher.data?.error
  );

  function openDialog() {
    setIsDialogOpen(true);
  }

  const closeDialog = useCallback(() => {
    zo.form?.reset();
    setMessageCharCount(0);
    setRole("");
    setIsExempt(false);
    setEmail("");
    lastChecked.current = null;
    setIsDialogOpen(false);
    onClose && onClose();
  }, [onClose, zo.form]);

  useEffect(
    function handleSuccess() {
      // Type narrowing: check for success data (no error, has success flag)
      if (fetcher.data && !fetcher.data.error && "success" in fetcher.data) {
        closeDialog();
        fetcher.reset();
      }
    },
    [closeDialog, fetcher]
  );

  if (!organization) {
    return null;
  }

  return (
    <>
      {trigger ? cloneElement(trigger, { onClick: openDialog }) : null}

      <DialogPortal>
        <Dialog
          className={className}
          title={
            <div className="mt-4 inline-flex items-center justify-center rounded-full border-4 border-solid border-primary-50 bg-primary-100 p-1.5 text-primary">
              <UserIcon />
            </div>
          }
          open={isDialogOpen || open}
          onClose={closeDialog}
        >
          <div className="px-6 py-4">
            <div className="mb-5">
              <h4>Invite team members</h4>
              <p>
                Invite a user to this workspace. Make sure to give them the
                proper role.
              </p>
            </div>

            <fetcher.Form
              ref={zo.ref}
              action="/api/settings/invite-user"
              method="post"
              className="flex flex-col gap-3"
            >
              <When truthy={!!teamMemberId}>
                <input
                  type="hidden"
                  name="teamMemberId"
                  value={teamMemberId!}
                />
              </When>

              <SelectGroup>
                <SelectLabel className="pl-0">Workspace</SelectLabel>
                <Select name="organizationId" defaultValue={organization.id}>
                  <div className="flex h-10 w-full items-center justify-between truncate rounded-md border border-gray-300 bg-transparent px-3.5 py-3 text-[16px] text-gray-500 placeholder:text-gray-500 focus:border-primary-300 focus:outline-none focus:ring-2 focus:ring-primary-25 focus:ring-offset-2 disabled:opacity-50  [&_span]:max-w-full [&_span]:truncate">
                    <SelectValue />
                  </div>
                  <SelectContent
                    position="popper"
                    className="w-full min-w-[300px] max-w-full"
                    align="start"
                  >
                    <div className=" max-h-[320px] overflow-auto ">
                      <SelectItem
                        value={organization.id}
                        key={organization.id}
                        className="p-2"
                      >
                        <div className="flex max-w-full items-center gap-2 truncate">
                          <Image
                            imageId={organization.imageId}
                            alt="img"
                            className="size-6 rounded-[2px] object-cover"
                          />

                          <div className=" ml-px max-w-full truncate text-sm text-gray-900">
                            {organization.name}
                          </div>
                        </div>
                      </SelectItem>
                    </div>
                  </SelectContent>
                </Select>
              </SelectGroup>

              <SelectGroup>
                <SelectLabel className="pl-0">Role</SelectLabel>
                <Select name="role" value={role} onValueChange={setRole}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select user role" />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    className="w-full min-w-[300px]"
                    align="start"
                  >
                    <div className=" max-h-[320px] overflow-auto">
                      {Object.entries(organizationRolesMap).map(([k, v]) => (
                        <SelectItem value={k} key={k} className="p-2">
                          <div className="flex items-center gap-2">
                            <div className=" ml-px block text-sm lowercase text-gray-900 first-letter:uppercase">
                              {v}
                            </div>
                          </div>
                        </SelectItem>
                      ))}
                    </div>
                  </SelectContent>
                </Select>
              </SelectGroup>
              <When
                truthy={
                  !!(
                    validationErrors?.role?.message || zo.errors.role()?.message
                  )
                }
              >
                <p className="-mt-1 text-sm text-error-500">
                  {validationErrors?.role?.message ||
                    zo.errors?.role()?.message}
                </p>
              </When>

              {/* BIG: exempt this invitee from the Neon membership requirement. */}
              <label
                htmlFor="membershipCheckExempt"
                className="flex items-start gap-2 pt-1.5"
              >
                <input
                  type="checkbox"
                  id="membershipCheckExempt"
                  name={zo.fields.membershipCheckExempt()}
                  disabled={disabled}
                  checked={isExempt}
                  onChange={(e) => setIsExempt(e.target.checked)}
                  className="mt-0.5 size-4 rounded border-gray-300 text-primary-600"
                />
                <span className="text-[14px] text-gray-600">
                  <span className="font-medium text-gray-700">
                    Doesn’t require a BIG membership
                  </span>
                  <br />
                  Tick for staff, volunteers or partners who should reserve
                  without an active Neon membership.
                </span>
              </label>

              <div className="pt-1.5">
                <Input
                  name={zo.fields.email()}
                  type="email"
                  autoComplete="email"
                  disabled={disabled}
                  error={
                    validationErrors?.email?.message ||
                    zo.errors.email()?.message
                  }
                  icon="mail"
                  label={"Email address"}
                  placeholder="zaans@huisje.com"
                  required
                  onBlur={(e) => setEmail(e.currentTarget.value)}
                />
              </div>

              {/* BIG: warn BEFORE the invite goes out that this person won't be
                  able to reserve — the failure otherwise surfaces to them, days
                  later, at the last step of a booking. */}
              <MembershipWarning state={membershipWarning} name={check?.name} />

              <div className="pt-1.5">
                <label
                  htmlFor="inviteMessage"
                  className="mb-2 block text-sm font-medium text-gray-700"
                >
                  Personal Message (Optional)
                </label>
                <textarea
                  id="inviteMessage"
                  name={zo.fields.inviteMessage()}
                  rows={4}
                  maxLength={1000}
                  disabled={disabled}
                  aria-describedby="inviteMessage-helper"
                  className="block w-full rounded-md border border-gray-300 px-3.5 py-2 text-sm text-gray-900 placeholder:text-gray-500 focus:border-primary-300 focus:outline-none focus:ring-2 focus:ring-primary-25 focus:ring-offset-2 disabled:opacity-50"
                  placeholder="Add a personal note to help them understand why you're inviting them to this workspace..."
                  onChange={(e) => setMessageCharCount(e.target.value.length)}
                />
                <div id="inviteMessage-helper" className="mt-1">
                  <span className="text-xs text-gray-500">
                    {messageCharCount} / 1000 characters
                  </span>
                  <When
                    truthy={
                      !!(
                        validationErrors?.inviteMessage?.message ||
                        zo.errors.inviteMessage()?.message
                      )
                    }
                  >
                    <p className="text-sm text-error-500">
                      {validationErrors?.inviteMessage?.message ||
                        zo.errors.inviteMessage()?.message}
                    </p>
                  </When>
                </div>
              </div>

              <When truthy={!!fetcher?.data?.error}>
                <p className="text-sm text-error-500">
                  {fetcher.data?.error?.message}
                </p>
              </When>

              <div className="mt-7 flex gap-1">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  width="full"
                  disabled={disabled}
                  onClick={closeDialog}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  width="full"
                  disabled={disabled}
                >
                  Send Invite
                </Button>
              </div>
            </fetcher.Form>
          </div>
        </Dialog>
      </DialogPortal>
    </>
  );
}
