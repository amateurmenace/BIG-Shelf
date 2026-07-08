/**
 * Loan Agreement signing — `/loan-agreement/:bookingId`
 *
 * A member reviews the equipment loan agreement filled in with their booking's
 * specifics (borrower, equipment, dates) and e-signs it (typed name + explicit
 * "I agree"). The signature is recorded immutably with a content snapshot + IP,
 * and the booking's checkout is gated on it (see `booking/service.server.ts`).
 *
 * Members can only sign their own bookings (ownership-checked). Admins/owners
 * may sign too (they pass the ownership guard).
 *
 * @see {@link file://./../../modules/big-loan-agreement/service.server.ts}
 */
import * as React from "react";
import Markdoc from "@markdoc/markdoc";
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
import { useZorm } from "react-zorm";
import { z } from "zod";
import Input from "~/components/forms/input";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import { db } from "~/database/db.server";
import { useDisabled } from "~/hooks/use-disabled";
import {
  fillAgreement,
  getActiveTemplate,
  getOrSeedTemplate,
  getSignatureForBooking,
  recordSignature,
  type AgreementMergeData,
} from "~/modules/big-loan-agreement/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { validateBookingOwnership } from "~/utils/booking-authorization.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { getValidationErrors } from "~/utils/http";
import type { DataOrErrorResponse } from "~/utils/http.server";
import { error, getParams, payload } from "~/utils/http.server";
import { parseMarkdownToReact } from "~/utils/md";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/** Formats a date for the agreement body (e.g. "July 7, 2026"). */
function formatAgreementDate(date: Date | null): string {
  if (!date) {
    return "the date of checkout";
  }
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** The e-signing form: a typed full name and an explicit agreement. */
const SignSchema = z.object({
  signerName: z.string().trim().min(2, "Please type your full name"),
  // A checked checkbox submits "on"; unchecked is absent → fails this literal.
  agree: z.literal("on", {
    errorMap: () => ({ message: "You must agree to the terms to sign" }),
  }),
});

/**
 * Loads the booking (org-scoped + ownership-checked) and its filled agreement.
 * Shared by the loader and action so both see identical terms.
 */
async function loadContext({
  bookingId,
  organizationId,
  organizationName,
  userId,
  role,
}: {
  bookingId: string;
  organizationId: string;
  organizationName: string;
  userId: string;
  role: Parameters<typeof validateBookingOwnership>[0]["role"];
}) {
  const booking = await db.booking.findFirst({
    where: { id: bookingId, organizationId },
    select: {
      id: true,
      name: true,
      from: true,
      to: true,
      creatorId: true,
      custodianUserId: true,
      custodianUser: {
        select: { firstName: true, lastName: true, email: true },
      },
      assets: { select: { title: true }, orderBy: { title: "asc" } },
    },
  });

  if (!booking) {
    throw new ShelfError({
      cause: null,
      message: "That reservation could not be found.",
      label: "Loan Agreement",
      status: 404,
      shouldBeCaptured: false,
    });
  }

  // The borrower (or staff) may only sign their own booking.
  validateBookingOwnership({
    booking: {
      creatorId: booking.creatorId,
      custodianUserId: booking.custodianUserId,
    },
    userId,
    role,
    action: "sign the loan agreement for",
  });

  const template = await getOrSeedTemplate({ organizationId, userId });

  const borrowerName =
    [booking.custodianUser?.firstName, booking.custodianUser?.lastName]
      .filter(Boolean)
      .join(" ") || "the borrower";
  const equipmentList = booking.assets.length
    ? booking.assets.map((asset) => `- ${asset.title}`).join("\n")
    : "- (equipment will be listed at checkout)";

  const merge: AgreementMergeData = {
    organizationName,
    borrowerName,
    borrowerEmail: booking.custodianUser?.email ?? "",
    equipmentList,
    checkoutDate: formatAgreementDate(booking.from),
    dueDate: formatAgreementDate(booking.to),
  };

  const filledContent = fillAgreement(template.content, merge);

  return { booking, template, filledContent, borrowerName };
}

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  const { bookingId } = getParams(params, z.object({ bookingId: z.string() }));

  try {
    const { organizationId, role, currentOrganization } =
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.booking,
        action: PermissionAction.read,
      });

    const { booking, template, filledContent, borrowerName } =
      await loadContext({
        bookingId,
        organizationId,
        organizationName: currentOrganization.name,
        userId,
        role,
      });

    const signature = await getSignatureForBooking({
      bookingId,
      organizationId,
    });

    const header: HeaderData = { title: template.title };

    return data(
      payload({
        header,
        bookingId,
        bookingName: booking.name,
        borrowerName,
        // Serializable markdoc tree — rendered client-side with Markdoc renderers.
        agreementTree: parseMarkdownToReact(filledContent),
        signature: signature
          ? { signerName: signature.signerName, signedAt: signature.signedAt }
          : null,
      })
    );
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request, params }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  const { bookingId } = getParams(params, z.object({ bookingId: z.string() }));

  try {
    const { organizationId, role, currentOrganization } =
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.booking,
        action: PermissionAction.update,
      });

    // Idempotent: if already signed, just move on.
    const existing = await getSignatureForBooking({
      bookingId,
      organizationId,
    });
    if (existing) {
      return redirect("/reserve?signed=1");
    }

    const formData = await request.formData();
    const { signerName } = parseSignForm(formData);

    const { booking, template, filledContent } = await loadContext({
      bookingId,
      organizationId,
      organizationName: currentOrganization.name,
      userId,
      role,
    });

    // Guard against a template disappearing between load and sign.
    const active = await getActiveTemplate(organizationId);
    if (!active) {
      throw new ShelfError({
        cause: null,
        message: "There is no loan agreement configured to sign.",
        label: "Loan Agreement",
        status: 409,
        shouldBeCaptured: false,
      });
    }

    await recordSignature({
      organizationId,
      bookingId: booking.id,
      signedByUserId: userId,
      signerName,
      signerEmail: booking.custodianUser?.email ?? "",
      template,
      contentSnapshot: filledContent,
      ipAddress:
        request.headers.get("fly-client-ip") ??
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        null,
      userAgent: request.headers.get("user-agent"),
    });

    return redirect("/reserve?signed=1");
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

/** Parses + validates the sign form, throwing a ShelfError on invalid input. */
function parseSignForm(formData: FormData): { signerName: string } {
  const result = SignSchema.safeParse({
    signerName: formData.get("signerName"),
    agree: formData.get("agree"),
  });
  if (!result.success) {
    throw new ShelfError({
      cause: result.error,
      message:
        result.error.issues[0]?.message ?? "Please complete the form to sign.",
      label: "Loan Agreement",
      status: 400,
      shouldBeCaptured: false,
    });
  }
  return { signerName: result.data.signerName };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title) },
];

export const handle = { name: "loan-agreement" };

/** Renders the filled agreement and the e-signing form (or the signed state). */
export default function LoanAgreementRoute() {
  const { bookingName, borrowerName, agreementTree, signature } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<DataOrErrorResponse>();
  const validationErrors = getValidationErrors<typeof SignSchema>(
    actionData?.error
  );
  const zo = useZorm("SignAgreement", SignSchema);
  const disabled = useDisabled();

  return (
    <div>
      <Header>
        <Button to="/reserve" variant="secondary">
          Back to reservations
        </Button>
      </Header>

      <div className="p-4 md:p-6">
        <p className="mb-4 text-sm text-gray-600">
          Reservation: <span className="font-medium">{bookingName}</span>
        </p>

        {/* The agreement */}
        <div className="prose prose-sm mb-6 max-h-[55vh] max-w-none overflow-y-auto rounded border border-gray-200 bg-white p-4 md:p-6">
          {Markdoc.renderers.react(agreementTree, React)}
        </div>

        {signature ? (
          <div className="rounded border border-success-200 bg-success-25 p-4 text-sm text-success-700 md:p-6">
            Signed by{" "}
            <span className="font-semibold">{signature.signerName}</span> on{" "}
            <DateS date={signature.signedAt} includeTime />. This reservation
            can now be checked out.
          </div>
        ) : (
          <Form
            ref={zo.ref}
            method="post"
            className="rounded border border-gray-200 bg-white p-4 md:p-6"
          >
            <p className="mb-4 text-sm text-gray-600">
              By signing, you ({borrowerName}) accept full responsibility and
              liability for the equipment as described above.
            </p>

            <Input
              label="Type your full legal name to sign"
              name={zo.fields.signerName()}
              placeholder="Your full name"
              disabled={disabled}
              required
              error={
                validationErrors?.signerName?.message ||
                zo.errors.signerName()?.message
              }
              className="mb-4 max-w-md"
            />

            <label className="mb-4 flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                name={zo.fields.agree()}
                value="on"
                disabled={disabled}
                className="mt-0.5 size-4"
              />
              <span>
                I have read, understand, and agree to be bound by this Equipment
                Loan Agreement, and I accept full responsibility and liability
                for the equipment.
              </span>
            </label>
            {validationErrors?.agree?.message || zo.errors.agree()?.message ? (
              <p className="mb-4 text-sm text-error-500">
                {validationErrors?.agree?.message || zo.errors.agree()?.message}
              </p>
            ) : null}

            <Button type="submit" disabled={disabled}>
              {disabled ? "Signing…" : "Sign agreement"}
            </Button>
          </Form>
        )}
      </div>
    </div>
  );
}
