/**
 * Member Scan — `/reserve/scan`
 *
 * Rapid-fire scan-to-order: point the camera at gear labels and every
 * available item drops STRAIGHT into the order — no page hops, no taps
 * between scans. Each scan gives loud feedback (green flash strip, haptic
 * buzz, and a running "scanned" list under the camera), then the camera just
 * keeps going, so sweeping a shelf of barcodes takes seconds.
 *
 * Flow per scan: the shared {@link CodeScanner} decodes QR / barcode / SAM-ID
 * → the value posts to this route's action → {@link resolveScannedCode}
 * resolves it ORG-SCOPED (a foreign label can never resolve) → the action
 * returns a light asset snapshot → the client adds it to the order atom
 * (deduped) and logs the outcome. Unavailable items log with a link to their
 * info page (waitlist); kit labels and unknown codes log a friendly note.
 * Scans are queued client-side so back-to-back detections never cancel each
 * other's lookups, and a short same-code cooldown stops one label from
 * machine-gunning entries while it's still in frame.
 *
 * @see {@link file://./reserve.order.tsx} — the checkout this feeds
 * @see {@link file://./reserve.equipment_.$assetId.tsx} — per-item info pages
 * @see {@link file://./../../modules/big-equipment/service.server.ts}
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleHelpIcon,
  PackageIcon,
} from "lucide-react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Link, useFetcher } from "react-router";
import { ClientOnly } from "remix-utils/client-only";
import { z } from "zod";
import type { EquipmentOrderItem } from "~/atoms/big-equipment-order";
import { equipmentOrderAtom } from "~/atoms/big-equipment-order";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import { CodeScanner } from "~/components/scanner/code-scanner";
import { Button } from "~/components/shared/button";
import { Spinner } from "~/components/shared/spinner";
import { db } from "~/database/db.server";
import { useHapticFeedback } from "~/hooks/use-haptic-feedback";
import { useViewportHeight } from "~/hooks/use-viewport-height";
import { refreshExpiredAssetImages } from "~/modules/asset/service.server";
import { resolveScannedCode } from "~/modules/big-equipment/service.server";
import { requireMemberPortalAccess } from "~/modules/big-member/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, parseData, payload } from "~/utils/http.server";
import { PermissionAction } from "~/utils/permissions/permission.data";
import { tw } from "~/utils/tw";

/** Ignore a re-detection of the same code within this window (label still in
 * frame while the camera keeps decoding). */
const SAME_CODE_COOLDOWN_MS = 4000;

/** How long the feedback strip stays visible after a scan. */
const FLASH_MS = 2200;

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
 * Resolves a scanned value (org-scoped) and returns a light, ANONYMIZED asset
 * snapshot the client can add to the order: id, title, status, thumbnail.
 * Non-bookable assets resolve as `not-found` — members never learn about gear
 * that isn't offered for booking.
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

    if (resolved.kind !== "asset") {
      return data(payload({ scan: { outcome: resolved.kind, value } }));
    }

    const asset = await db.asset.findFirst({
      where: { id: resolved.assetId, organizationId, availableToBook: true },
      select: {
        id: true,
        title: true,
        status: true,
        organizationId: true,
        mainImage: true,
        thumbnailImage: true,
        mainImageExpiration: true,
      },
    });
    if (!asset) {
      return data(payload({ scan: { outcome: "not-found" as const, value } }));
    }

    // Re-sign an expired image URL so the list thumbnail never 404s.
    const [fresh] = await refreshExpiredAssetImages([asset]);

    return data(
      payload({
        scan: {
          outcome: "asset" as const,
          value,
          asset: {
            id: fresh.id,
            title: fresh.title,
            available: String(fresh.status) === "AVAILABLE",
            image: fresh.thumbnailImage ?? fresh.mainImage,
          },
        },
      })
    );
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

/** One row in the "scanned this session" list. */
type ScanLogEntry = {
  key: string;
  outcome: "added" | "already" | "unavailable" | "kit" | "not-found";
  assetId?: string;
  title?: string;
  image?: string | null;
  value?: string;
};

/** The feedback strip's tone + message. */
type Flash = { tone: "success" | "info" | "warn"; text: string };

/** Copy per log outcome. */
const OUTCOME_BADGE: Record<
  ScanLogEntry["outcome"],
  { label: string; className: string }
> = {
  added: {
    label: "Added to order",
    className: "bg-success-50 text-success-700",
  },
  already: {
    label: "Already in order",
    className: "bg-gray-100 text-gray-600",
  },
  unavailable: { label: "In use", className: "bg-warning-50 text-warning-700" },
  kit: { label: "Kit — ask staff", className: "bg-gray-100 text-gray-600" },
  "not-found": {
    label: "Not recognized",
    className: "bg-error-50 text-error-700",
  },
};

export default function MemberScanPage() {
  return (
    <div>
      <Header hidePageDescription />
      <ClientOnly
        fallback={
          <div className="flex h-64 items-center justify-center">
            <Spinner />
          </div>
        }
      >
        {() => <ContinuousScanner />}
      </ClientOnly>
    </div>
  );
}

/**
 * The live scanner: camera on top, feedback strip over it, session list
 * below, sticky "Review order" footer. Client-only (camera + cart atom).
 */
function ContinuousScanner() {
  const fetcher = useFetcher<typeof action>({ key: "big-scan-resolve" });
  const [order, setOrder] = useAtom(equipmentOrderAtom);
  const { triggerSuccess, triggerError } = useHapticFeedback();

  const [scanLog, setScanLog] = useState<ScanLogEntry[]>([]);
  const [flash, setFlash] = useState<Flash | null>(null);

  // The camera keeps ITS view running the whole time — we never pause it.
  const [paused, setPaused] = useState(false);

  /** value → last-seen ms, so one label in frame doesn't spam entries. */
  const recentValues = useRef<Map<string, number>>(new Map());
  /** Queued scans while a lookup is in flight (fast sweeps never drop). */
  const pendingScans = useRef<{ value: string; type: string }[]>([]);
  /**
   * Whether a lookup is in flight RIGHT NOW. A ref (not `fetcher.state`)
   * because several detections can fire in the same tick — the render
   * closure's fetcher.state would still read "idle" and each new submit
   * would CANCEL the in-flight one, dropping scans.
   */
  const inFlight = useRef(false);
  /** The order list, readable inside effects without re-binding them. */
  const orderRef = useRef(order);
  orderRef.current = order;

  const { vh, isMd } = useViewportHeight();
  const totalHeight = Math.max(isMd ? vh - 132 : vh - 152, 420);
  const cameraHeight = Math.max(Math.round(totalHeight * 0.52), 240);

  /** Auto-clear the feedback strip. */
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const submitScan = useCallback(
    (value: string, type: string) => {
      if (inFlight.current) {
        pendingScans.current.push({ value, type });
        return;
      }
      inFlight.current = true;
      void fetcher.submit({ value, type }, { method: "post" });
    },
    [fetcher]
  );

  /** A code was decoded by the camera/scanner-gun. */
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
        triggerError();
        setFlash({ tone: "warn", text: scanError });
        return;
      }
      const now = Date.now();
      const lastSeen = recentValues.current.get(value);
      if (lastSeen && now - lastSeen < SAME_CODE_COOLDOWN_MS) {
        return; // same label still in frame — ignore quietly
      }
      recentValues.current.set(value, now);
      submitScan(value, type ?? "qr");
    },
    [submitScan, triggerError]
  );

  // Process each lookup result: add to order / log the outcome, then fire
  // the next queued scan (if the member swept several labels quickly).
  useEffect(() => {
    if (fetcher.state !== "idle") return;

    // Whatever happened, when the fetcher settles either fire the next
    // queued scan or mark the pipeline free again.
    const advanceQueue = () => {
      const next = pendingScans.current.shift();
      if (next) {
        void fetcher.submit(
          { value: next.value, type: next.type },
          { method: "post" }
        );
      } else {
        inFlight.current = false;
      }
    };

    const result = fetcher.data;
    if (!result || consumedResults.has(result)) {
      advanceQueue();
      return;
    }
    // Consume the result exactly once per response object.
    consumedResults.add(result);

    if ("error" in result && result.error) {
      triggerError();
      setFlash({ tone: "warn", text: result.error.message });
    } else if ("scan" in result && result.scan) {
      const scan = result.scan;
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      if (scan.outcome === "asset" && "asset" in scan && scan.asset) {
        const asset = scan.asset;
        if (!asset.available) {
          triggerError();
          setFlash({ tone: "warn", text: `${asset.title} is in use` });
          setScanLog((log) => [
            {
              key,
              outcome: "unavailable",
              assetId: asset.id,
              title: asset.title,
              image: asset.image,
            },
            ...log,
          ]);
        } else if (orderRef.current.some((item) => item.id === asset.id)) {
          triggerSuccess();
          setFlash({
            tone: "info",
            text: `${asset.title} is already in your order`,
          });
          setScanLog((log) => [
            {
              key,
              outcome: "already",
              assetId: asset.id,
              title: asset.title,
              image: asset.image,
            },
            ...log,
          ]);
        } else {
          const item: EquipmentOrderItem = {
            id: asset.id,
            title: asset.title,
            image: asset.image ?? null,
          };
          setOrder((current) =>
            current.some((entry) => entry.id === item.id)
              ? current
              : [...current, item]
          );
          triggerSuccess();
          setFlash({ tone: "success", text: `Added: ${asset.title}` });
          setScanLog((log) => [
            {
              key,
              outcome: "added",
              assetId: asset.id,
              title: asset.title,
              image: asset.image,
            },
            ...log,
          ]);
        }
      } else if (scan.outcome === "kit") {
        triggerError();
        setFlash({
          tone: "info",
          text: "That's a kit — ask staff to book it for you",
        });
        setScanLog((log) => [{ key, outcome: "kit" }, ...log]);
      } else {
        triggerError();
        setFlash({ tone: "warn", text: "Code not recognized" });
        setScanLog((log) => [
          { key, outcome: "not-found", value: scan.value },
          ...log,
        ]);
      }
    }

    advanceQueue();
  }, [
    fetcher,
    fetcher.state,
    fetcher.data,
    setOrder,
    triggerSuccess,
    triggerError,
  ]);

  return (
    <div
      className="-mx-4 flex flex-col overflow-hidden md:mx-0"
      style={{ height: `${totalHeight}px` }}
    >
      {/* Camera — never pauses; the feedback strip floats over it */}
      <div
        className="relative shrink-0 overflow-hidden md:rounded-lg md:border md:border-gray-200"
        style={{ height: `${cameraHeight}px` }}
      >
        <CodeScanner
          onCodeDetectionSuccess={handleCodeDetectionSuccess}
          paused={paused}
          setPaused={setPaused}
          allowNonShelfCodes
          hideBackButtonText
          backButtonUrl="/reserve"
        />

        {/* Feedback strip */}
        {flash ? (
          <div
            role="status"
            className={tw(
              "pointer-events-none absolute inset-x-3 bottom-3 z-20 flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold shadow-lg",
              flash.tone === "success" && "bg-success-600 text-white",
              flash.tone === "info" && "bg-gray-900/90 text-white",
              flash.tone === "warn" && "bg-warning-500 text-white"
            )}
          >
            {flash.tone === "success" ? (
              <CheckCircle2Icon className="size-5 shrink-0" aria-hidden />
            ) : (
              <CircleAlertIcon className="size-5 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate">{flash.text}</span>
          </div>
        ) : null}
      </div>

      {/* Session list — every scan lands here, newest first */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-white px-4 md:px-0">
        {scanLog.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-500">
            Point the camera at a QR or barcode label — items you scan appear
            here and drop into your order.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {scanLog.map((entry) => {
              const badge = OUTCOME_BADGE[entry.outcome];
              return (
                <li key={entry.key} className="flex items-center gap-3 py-2.5">
                  <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-gray-100 bg-gray-50">
                    {entry.image ? (
                      <img
                        src={entry.image}
                        alt=""
                        className="size-full object-cover"
                      />
                    ) : entry.outcome === "not-found" ? (
                      <CircleHelpIcon
                        className="size-5 text-gray-300"
                        aria-hidden
                      />
                    ) : (
                      <PackageIcon
                        className="size-5 text-gray-300"
                        aria-hidden
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    {entry.assetId ? (
                      <Link
                        to={`/reserve/equipment/${entry.assetId}`}
                        className="block truncate text-sm font-medium text-gray-900 hover:underline"
                      >
                        {entry.title}
                      </Link>
                    ) : (
                      <p className="truncate text-sm font-medium text-gray-700">
                        {entry.outcome === "kit"
                          ? "Kit label"
                          : entry.value ?? "Unknown code"}
                      </p>
                    )}
                    <span
                      className={tw(
                        "mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium",
                        badge.className
                      )}
                    >
                      {badge.label}
                    </span>
                  </div>
                  {entry.outcome === "unavailable" && entry.assetId ? (
                    <Link
                      to={`/reserve/equipment/${entry.assetId}`}
                      className="shrink-0 text-xs font-medium text-primary-700 hover:text-primary-800"
                    >
                      Waitlist
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Sticky footer CTA */}
      <div className="shrink-0 border-t border-gray-200 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:px-0">
        <Button to="/reserve/order" width="full" disabled={order.length === 0}>
          {order.length === 0
            ? "Scan items to build your order"
            : `Review order (${order.length} item${
                order.length === 1 ? "" : "s"
              })`}
        </Button>
      </div>
    </div>
  );
}

/** Response objects already handled (fetcher.data persists between effects). */
const consumedResults = new WeakSet<object>();

export const ErrorBoundary = () => <ErrorContent />;
