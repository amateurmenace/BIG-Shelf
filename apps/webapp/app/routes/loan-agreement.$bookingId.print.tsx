/**
 * Printable loan agreement — `/loan-agreement/:bookingId/print`
 *
 * BIG: for in-person and staff-arranged reservations, staff print the loan
 * agreement and the borrower signs the paper copy INSTEAD of e-signing. Staff
 * then record the paper signature on the signing page, which satisfies the
 * checkout gate the same way an e-signature does.
 *
 * The copy is word-for-word what would be e-signed — both pages build it with
 * the same `buildAgreementForBooking` — and adds what paper needs: the
 * equipment and supplies as tables with Out / Returned tick boxes, and lines
 * for the borrower's and a staff member's signature.
 *
 * Lives OUTSIDE `_layout+` (like the kiosk) so no sidebar or app chrome prints.
 * Auth is still enforced — this is not a public route. Staff only: members
 * sign digitally.
 *
 * `?autoprint=1` opens the browser's print dialog on load; the "Print" buttons
 * that open this page pass it.
 *
 * @see {@link file://./_layout+/loan-agreement.$bookingId.tsx} — signing + recording paper
 * @see {@link file://./../modules/big-loan-agreement/service.server.ts}
 */
import * as React from "react";
import { useEffect } from "react";
import Markdoc from "@markdoc/markdoc";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, useLoaderData } from "react-router";
import { z } from "zod";
import { LoanItemsList } from "~/components/big/loan-agreement/loan-items";
import { ErrorContent } from "~/components/errors";
import { DateS } from "~/components/shared/date";
import { useSearchParams } from "~/hooks/search-params";
import { buildAgreementForBooking } from "~/modules/big-loan-agreement/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, getParams, payload } from "~/utils/http.server";
import { parseMarkdownToReact } from "~/utils/md";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/** Paper margins, and no browser-added page furniture beyond what the OS adds. */
const PRINT_CSS = "@page { size: auto; margin: 16mm; }";

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

    // Paper signing is a desk procedure run by staff; members e-sign.
    if (isSelfServiceOrBase) {
      throw new ShelfError({
        cause: null,
        title: "Not allowed",
        message:
          "Only staff can print a loan agreement for an in-person signature.",
        label: "Loan Agreement",
        status: 403,
        shouldBeCaptured: false,
      });
    }

    const {
      booking,
      template,
      filledContent,
      borrowerName,
      borrowerEmail,
      items,
    } = await buildAgreementForBooking({
      bookingId,
      organizationId,
      organization: currentOrganization,
      userId,
      role,
    });

    return data(
      payload({
        organizationName: currentOrganization.name,
        title: template.title,
        version: template.version,
        bookingId: booking.id,
        bookingName: booking.name,
        from: booking.from,
        to: booking.to,
        borrowerName,
        borrowerEmail,
        items,
        agreementTree: parseMarkdownToReact(filledContent),
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

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  {
    title: appendToMetaTitle(
      loaderData ? `${loaderData.title} — ${loaderData.bookingName}` : "Print"
    ),
  },
];

/** A labelled line to sign or write on. */
function SignatureLine({ label }: { label: string }) {
  return (
    <div className="flex-1">
      <div className="h-10 border-b border-gray-700" />
      <p className="mt-1 text-xs text-gray-700">{label}</p>
    </div>
  );
}

/** The printable agreement: header, items, terms and signature lines. */
export default function PrintLoanAgreement() {
  const {
    organizationName,
    title,
    version,
    bookingId,
    bookingName,
    from,
    to,
    borrowerName,
    borrowerEmail,
    items,
    agreementTree,
  } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const autoprint = searchParams.get("autoprint") === "1";

  // Open the print dialog once the page has rendered.
  useEffect(() => {
    if (autoprint) window.print();
  }, [autoprint]);

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <style>{PRINT_CSS}</style>

      {/* Screen-only controls */}
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-6 py-3 print:hidden">
        <a
          href={`/bookings/${bookingId}`}
          className="text-sm font-medium text-primary-700 hover:underline"
        >
          ← Back to booking
        </a>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
        >
          Print
        </button>
      </div>

      <main className="mx-auto max-w-3xl px-6 py-8 print:max-w-none print:p-0">
        <header className="mb-6 border-b border-gray-300 pb-4">
          <p className="text-sm font-medium text-gray-700">
            {organizationName}
          </p>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="inline font-medium">Borrower: </dt>
              <dd className="inline">
                {borrowerName}
                {borrowerEmail ? ` (${borrowerEmail})` : ""}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Reservation: </dt>
              <dd className="inline">{bookingName}</dd>
            </div>
            <div>
              <dt className="inline font-medium">From: </dt>
              <dd className="inline">
                <DateS date={from} includeTime />
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Due back: </dt>
              <dd className="inline">
                <DateS date={to} includeTime />
              </dd>
            </div>
          </dl>
        </header>

        <section aria-labelledby="print-items-heading" className="mb-6">
          <h2 id="print-items-heading" className="mb-2 text-base font-semibold">
            What&apos;s being borrowed
          </h2>
          <LoanItemsList items={items} variant="print" />
        </section>

        <section
          aria-label="Agreement terms"
          className="prose prose-sm mb-8 max-w-none"
        >
          {Markdoc.renderers.react(agreementTree, React)}
        </section>

        {/* Keep the signature block on one page. */}
        <section
          aria-labelledby="print-signatures-heading"
          className="break-inside-avoid"
        >
          <h2
            id="print-signatures-heading"
            className="mb-4 text-base font-semibold"
          >
            Signatures
          </h2>
          <div className="mb-6 flex gap-6">
            <SignatureLine label="Borrower signature" />
            <div className="w-40">
              <SignatureLine label="Date" />
            </div>
          </div>
          <div className="mb-6 flex gap-6">
            <SignatureLine label="Borrower name (print)" />
          </div>
          <div className="mb-6 flex gap-6">
            <SignatureLine label="Staff member" />
            <div className="w-40">
              <SignatureLine label="Date" />
            </div>
          </div>
          <p className="text-xs text-gray-600">
            Staff: once signed, record this agreement in BIG Shelf on the
            booking&apos;s loan agreement page, and keep this copy on file.
            Agreement version {version} · Booking {bookingId}
          </p>
        </section>
      </main>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
