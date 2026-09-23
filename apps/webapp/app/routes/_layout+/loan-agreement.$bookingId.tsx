/**
 * Loan Agreement signing — `/loan-agreement/:bookingId`
 *
 * A member reviews the equipment loan agreement filled in with their booking's
 * specifics (borrower, equipment, supplies, dates) and e-signs it (typed name +
 * explicit "I agree"). The signature is recorded immutably with a content
 * snapshot + IP, and the booking's checkout is gated on it (see
 * `booking/service.server.ts`).
 *
 * Members can only sign their own bookings (ownership-checked). Admins/owners
 * may sign too (they pass the ownership guard).
 *
 * BIG: staff running an in-person or staff-arranged reservation can instead
 * PRINT the agreement, have the borrower sign the paper copy, and record it
 * here. A recorded paper signature satisfies the checkout gate exactly like an
 * e-signature, and is stored as `method: PAPER` so the audit trail says which
 * happened. Members never see the paper option.
 *
 * The page lists the equipment AND supplies being borrowed, above the terms.
 *
 * @see {@link file://./../../modules/big-loan-agreement/service.server.ts}
 * @see {@link file://./../loan-agreement.$bookingId.print.tsx} — the printable copy
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
import { LoanItemsList } from "~/components/big/loan-agreement/loan-items";
import Input from "~/components/forms/input";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import { useDisabled } from "~/hooks/use-disabled";
import {
  buildAgreementForBooking,
  getActiveTemplate,
  getSignatureForBooking,
  getSignatureSummary,
  recordSignature,
} from "~/modules/big-loan-agreement/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { getValidationErrors } from "~/utils/http";
import type { DataOrErrorResponse } from "~/utils/http.server";
import { error, getParams, parseData, payload } from "~/utils/http.server";
import { parseMarkdownToReact } from "~/utils/md";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/** The e-signing form: a typed full name and an explicit agreement. */
const SignSchema = z.object({
  signerName: z.string().trim().min(2, "Please type your full name"),
  // A checked checkbox submits "on"; unchecked is absent → fails this literal.
  agree: z.literal("on", {
    errorMap: () => ({ message: "You must agree to the terms to sign" }),
  }),
});

/**
 * BIG: staff recording a signature made on a printed copy. Field names differ
 * from {@link SignSchema}'s so a server error lands under the right form.
 */
const PaperSchema = z.object({
  paperSignerName: z
    .string()
    .trim()
    .min(2, "Type the borrower's name as they signed it"),
  witnessed: z.literal("on", {
    errorMap: () => ({
      message: "Confirm the borrower signed the printed agreement",
    }),
  }),
});

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  const { bookingId } = getParams(params, z.object({ bookingId: z.string() }));

  try {
    const { organizationId, role, currentOrganization, isSelfServiceOrBase } =
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.booking,
        action: PermissionAction.read,
      });

    const [
      { booking, template, filledContent, borrowerName, items },
      signature,
    ] = await Promise.all([
      buildAgreementForBooking({
        bookingId,
        organizationId,
        organization: currentOrganization,
        userId,
        role,
      }),
      getSignatureSummary({ bookingId, organizationId }),
    ]);

    const header: HeaderData = { title: template.title };

    return data(
      payload({
        header,
        bookingId,
        bookingName: booking.name,
        borrowerName,
        items,
        // Serializable markdoc tree — rendered client-side with Markdoc renderers.
        agreementTree: parseMarkdownToReact(filledContent),
        signature,
        // Only staff may print for an in-person signature and record it.
        isStaff: !isSelfServiceOrBase,
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
    const { organizationId, role, currentOrganization, isSelfServiceOrBase } =
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.booking,
        action: PermissionAction.update,
      });

    // Staff go back to the booking they are working on; members to their
    // reservations, where the "signed" confirmation lives.
    const whenDone = isSelfServiceOrBase
      ? "/reserve?signed=1"
      : `/bookings/${bookingId}`;

    // Idempotent: if already signed, just move on.
    const existing = await getSignatureForBooking({
      bookingId,
      organizationId,
    });
    if (existing) {
      return redirect(whenDone);
    }

    const formData = await request.formData();
    const isPaper = formData.get("intent") === "paper";

    if (isPaper && isSelfServiceOrBase) {
      throw new ShelfError({
        cause: null,
        title: "Not allowed",
        message: "Only staff can record a signature made on paper.",
        label: "Loan Agreement",
        status: 403,
        shouldBeCaptured: false,
      });
    }

    const signerName = isPaper
      ? parseData(formData, PaperSchema).paperSignerName
      : parseData(formData, SignSchema).signerName;

    const { booking, template, filledContent, borrowerEmail } =
      await buildAgreementForBooking({
        bookingId,
        organizationId,
        organization: currentOrganization,
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
      // For a paper signature this is the staff member who recorded it.
      signedByUserId: userId,
      signerName,
      signerEmail: borrowerEmail,
      template,
      contentSnapshot: filledContent,
      method: isPaper ? "PAPER" : "DIGITAL",
      ipAddress:
        request.headers.get("fly-client-ip") ??
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        null,
      userAgent: request.headers.get("user-agent"),
    });

    if (isPaper) {
      sendNotification({
        title: "Paper agreement recorded",
        message: "This reservation can now be checked out.",
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });
    }

    return redirect(whenDone);
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title) },
];

export const handle = { name: "loan-agreement" };

/** Renders the items, the filled agreement and the ways to sign it. */
export default function LoanAgreementRoute() {
  const {
    bookingId,
    bookingName,
    borrowerName,
    items,
    agreementTree,
    signature,
    isStaff,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<DataOrErrorResponse>();
  const signErrors = getValidationErrors<typeof SignSchema>(actionData?.error);
  const paperErrors = getValidationErrors<typeof PaperSchema>(
    actionData?.error
  );
  // A failure that belongs to no field (403, 409, …) still needs showing.
  const generalError =
    actionData?.error && !signErrors && !paperErrors
      ? actionData.error.message
      : null;
  const zo = useZorm("SignAgreement", SignSchema);
  const paperZo = useZorm("PaperAgreement", PaperSchema);
  const disabled = useDisabled();

  return (
    <div>
      <Header>
        <Button
          to={isStaff ? `/bookings/${bookingId}` : "/reserve"}
          variant="secondary"
        >
          {isStaff ? "Back to booking" : "Back to reservations"}
        </Button>
      </Header>

      <div className="p-4 md:p-6">
        <p className="mb-4 text-sm text-gray-600">
          Reservation: <span className="font-medium">{bookingName}</span>
        </p>

        {/* What's being borrowed — equipment AND supplies */}
        <section
          aria-labelledby="loan-items-heading"
          className="mb-6 rounded border border-gray-200 bg-white p-4 md:p-6"
        >
          <h2
            id="loan-items-heading"
            className="mb-3 text-base font-semibold text-gray-900"
          >
            What&apos;s being borrowed
          </h2>
          <LoanItemsList items={items} variant="screen" />
        </section>

        {/* The agreement */}
        <div className="prose prose-sm mb-6 max-h-[55vh] max-w-none overflow-y-auto rounded border border-gray-200 bg-white p-4 md:p-6">
          {Markdoc.renderers.react(agreementTree, React)}
        </div>

        {generalError ? (
          <p
            role="alert"
            className="mb-4 rounded border border-error-200 bg-error-25 p-3 text-sm text-error-600"
          >
            {generalError}
          </p>
        ) : null}

        {signature ? (
          <div className="rounded border border-success-200 bg-success-25 p-4 text-sm text-success-700 md:p-6">
            {signature.method === "PAPER" ? (
              <>
                Signed on paper by{" "}
                <span className="font-semibold">{signature.signerName}</span>
                {signature.recordedBy
                  ? ` — recorded by ${signature.recordedBy}`
                  : ""}{" "}
                on <DateS date={signature.signedAt} includeTime />.
              </>
            ) : (
              <>
                Signed by{" "}
                <span className="font-semibold">{signature.signerName}</span> on{" "}
                <DateS date={signature.signedAt} includeTime />.
              </>
            )}{" "}
            This reservation can now be checked out.
          </div>
        ) : (
          <div className="space-y-6">
            {isStaff ? (
              <section
                aria-labelledby="in-person-heading"
                className="rounded border border-gray-200 bg-white p-4 md:p-6"
              >
                <h2
                  id="in-person-heading"
                  className="text-base font-semibold text-gray-900"
                >
                  Signing in person?
                </h2>
                <p className="mb-4 mt-1 text-sm text-gray-600">
                  Print the agreement, have the borrower sign the paper copy,
                  then record it here. Keep the signed copy on file — it
                  replaces the digital signature.
                </p>
                <Button
                  to={`/loan-agreement/${bookingId}/print?autoprint=1`}
                  target="_blank"
                  variant="secondary"
                  icon="print"
                  className="mb-5"
                >
                  Print agreement
                </Button>

                <Form ref={paperZo.ref} method="post">
                  <input type="hidden" name="intent" value="paper" />
                  <Input
                    label="Borrower's name, as signed"
                    name={paperZo.fields.paperSignerName()}
                    defaultValue={
                      borrowerName === "the borrower" ? "" : borrowerName
                    }
                    disabled={disabled}
                    required
                    error={
                      paperErrors?.paperSignerName?.message ||
                      paperZo.errors.paperSignerName()?.message
                    }
                    className="mb-4 max-w-md"
                  />
                  <label className="mb-4 flex items-start gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      name={paperZo.fields.witnessed()}
                      value="on"
                      disabled={disabled}
                      className="mt-0.5 size-4"
                    />
                    <span>
                      The borrower signed the printed agreement, and I have the
                      signed copy.
                    </span>
                  </label>
                  {paperErrors?.witnessed?.message ||
                  paperZo.errors.witnessed()?.message ? (
                    <p className="mb-4 text-sm text-error-500">
                      {paperErrors?.witnessed?.message ||
                        paperZo.errors.witnessed()?.message}
                    </p>
                  ) : null}
                  <Button type="submit" variant="secondary" disabled={disabled}>
                    {disabled ? "Recording…" : "Record paper signature"}
                  </Button>
                </Form>
              </section>
            ) : null}

            <Form
              ref={zo.ref}
              method="post"
              className="rounded border border-gray-200 bg-white p-4 md:p-6"
            >
              {isStaff ? (
                <h2 className="mb-1 text-base font-semibold text-gray-900">
                  Or sign digitally
                </h2>
              ) : null}
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
                  signErrors?.signerName?.message ||
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
                  I have read, understand, and agree to be bound by this
                  Equipment Loan Agreement, and I accept full responsibility and
                  liability for the equipment.
                </span>
              </label>
              {signErrors?.agree?.message || zo.errors.agree()?.message ? (
                <p className="mb-4 text-sm text-error-500">
                  {signErrors?.agree?.message || zo.errors.agree()?.message}
                </p>
              ) : null}

              <Button type="submit" disabled={disabled}>
                {disabled ? "Signing…" : "Sign agreement"}
              </Button>
            </Form>
          </div>
        )}
      </div>
    </div>
  );
}
