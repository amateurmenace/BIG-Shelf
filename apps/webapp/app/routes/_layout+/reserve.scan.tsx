/**
 * Member Scan — `/reserve/scan`
 *
 * Point your phone at a QR label or barcode on any piece of gear and land on
 * its equipment info page (photo, guides, availability, "Add to order").
 * The heart of the mobile scan-to-reserve flow.
 *
 * Reuses the shared {@link CodeScanner} (camera + scanner-gun modes; QR,
 * barcode, and SAM-ID input). Detected values post to this route's action,
 * which resolves them ORG-SCOPED via {@link resolveScannedCode} — a label
 * printed by another workspace resolves to a friendly "not found", never to
 * someone else's asset. Kit labels get a friendly "ask staff" message (kits
 * aren't member-bookable).
 *
 * @see {@link file://./reserve.equipment_.$assetId.tsx} — where a scan lands
 * @see {@link file://./../../modules/big-equipment/service.server.ts}
 */
import { useCallback, useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useNavigate } from "react-router";
import { ClientOnly } from "remix-utils/client-only";
import { z } from "zod";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import { CodeScanner } from "~/components/scanner/code-scanner";
import { Spinner } from "~/components/shared/spinner";
import { useViewportHeight } from "~/hooks/use-viewport-height";
import { resolveScannedCode } from "~/modules/big-equipment/service.server";
import { requireMemberPortalAccess } from "~/modules/big-member/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, parseData, payload } from "~/utils/http.server";
import { PermissionAction } from "~/utils/permissions/permission.data";

/**
 * Gate only — the page itself has no server data.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    await requireMemberPortalAccess({
      userId,
      request,
      action: PermissionAction.read,
    });
    return payload({ header: { title: "Scan to reserve" } });
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

/** What the scanner posts for resolution. */
const ResolveSchema = z.object({
  value: z.string().min(1),
  type: z.enum(["qr", "barcode", "samId"]),
});

/**
 * Resolves a scanned value to an asset (org-scoped) and returns where to go.
 */
export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requireMemberPortalAccess({
      userId,
      request,
      action: PermissionAction.read,
    });

    const formData = await request.formData();
    const { value, type } = parseData(formData, ResolveSchema, {
      shouldBeCaptured: false,
      additionalData: { userId, organizationId },
    });

    const resolved = await resolveScannedCode({ organizationId, value, type });
    return data(payload({ resolved }));
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

export const handle = {
  breadcrumb: () => "single",
  name: "reserve.scan",
};

/**
 * The scanner page: full-height camera view; a resolved asset navigates to
 * its info page, anything else shows a friendly overlay and resumes.
 */
export default function MemberScanPage() {
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const [paused, setPaused] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | undefined>();
  const [errorTitle, setErrorTitle] = useState<string | undefined>();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const { vh, isMd } = useViewportHeight();
  const height = isMd ? vh - 132 : vh - 167;

  /** A code was decoded — pause and send it for org-scoped resolution. */
  const handleCodeDetectionSuccess = useCallback(
    ({
      value,
      type,
      error: scanError,
    }: {
      value: string;
      type?: "qr" | "barcode" | "samId";
      error?: string;
    }) => {
      if (scanError) {
        setPaused(true);
        setErrorTitle("Couldn't read that code");
        setErrorMessage(scanError);
        return;
      }
      setPaused(true);
      setScanMessage("Looking that up…");
      setErrorTitle(undefined);
      setErrorMessage(undefined);
      void fetcher.submit({ value, type: type ?? "qr" }, { method: "post" });
    },
    [fetcher]
  );

  // Act on the resolution: asset → its info page; kit/unknown → friendly
  // error overlay, then the member can scan again.
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle") return;

    if ("error" in result && result.error) {
      setScanMessage(undefined);
      setErrorTitle("Scan failed");
      setErrorMessage(result.error.message);
      return;
    }
    if ("resolved" in result && result.resolved) {
      if (result.resolved.kind === "asset") {
        setScanMessage("Found it — opening…");
        void navigate(`/reserve/equipment/${result.resolved.assetId}`);
        return;
      }
      setScanMessage(undefined);
      setErrorTitle(
        result.resolved.kind === "kit" ? "That's a kit" : "Not recognized"
      );
      setErrorMessage(
        result.resolved.kind === "kit"
          ? "Kits can't be reserved from the member portal yet — ask staff to book it for you."
          : "That code doesn't match any BIG equipment. Try the QR or barcode label on the item."
      );
    }
  }, [fetcher.data, fetcher.state, navigate]);

  return (
    <div>
      <Header hidePageDescription />
      <p className="px-4 pb-2 text-sm text-gray-600 md:px-0">
        Point your camera at the QR code or barcode label on any piece of gear
        to see its details and add it to your order.
      </p>
      <div
        className="-mx-4 flex flex-col overflow-hidden md:mx-0 md:rounded-lg md:border md:border-gray-200"
        style={{ height: `${height}px` }}
      >
        <ClientOnly
          fallback={
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          }
        >
          {() => (
            <CodeScanner
              onCodeDetectionSuccess={handleCodeDetectionSuccess}
              paused={paused}
              setPaused={(next) => {
                setPaused(next);
                if (!next) {
                  setScanMessage(undefined);
                  setErrorTitle(undefined);
                  setErrorMessage(undefined);
                }
              }}
              scanMessage={scanMessage}
              errorTitle={errorTitle}
              errorMessage={errorMessage}
              allowNonShelfCodes
              backButtonText="Member home"
              backButtonUrl="/reserve"
            />
          )}
        </ClientOnly>
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
