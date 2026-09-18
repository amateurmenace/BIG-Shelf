/**
 * Equipment check-in wizard — `/check-in`
 *
 * The returns desk, on a phone. Point the camera at each label as gear comes
 * back over the counter; anything that looks wrong gets photographed and
 * written up right there, before it goes back on the shelf.
 *
 * Why it exists: checking gear in previously meant finding the booking first,
 * and reporting damage meant a second trip to the asset page afterwards — so in
 * practice damage got noticed at the counter and written up never. Putting the
 * camera, the batch and the condition report on one screen is the whole point.
 *
 * Flow:
 *  1. **Scan** — the shared {@link CodeScanner} decodes QR / barcode / SAM-ID;
 *     each code resolves org-scoped and drops into the batch. Scans are queued
 *     client-side so a fast sweep never cancels an in-flight lookup (the same
 *     `inFlight` ref pattern as the member scanner).
 *  2. **Flag** — tap any row to open a condition report: grade, note and an
 *     optional photo straight from the phone camera. Posts to
 *     `/api/big-condition-report` without leaving the page.
 *  3. **Check in** — the whole batch posts to `/api/big-desk` (`intent=check-in`),
 *     which groups assets by their ONGOING/OVERDUE booking and runs upstream's
 *     `partialCheckinBooking` per booking. Per-asset problems come back as
 *     failures and are shown inline; one bad scan never blocks the pile.
 *
 * BIG-only additive route. Gated on `booking:checkin`.
 *
 * @see {@link file://./../api+/big-desk.ts} — the batch check-in
 * @see {@link file://./../api+/big-condition-report.ts} — the damage report
 * @see {@link file://./reserve.scan.tsx} — the member scanner this mirrors
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AssetConditionType } from "@prisma/client";
import {
  CameraIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher } from "react-router";
import { ClientOnly } from "remix-utils/client-only";
import { ErrorContent } from "~/components/errors";
import Input from "~/components/forms/input";
import Header from "~/components/layout/header";
import { CodeScanner } from "~/components/scanner/code-scanner";
import { Button } from "~/components/shared/button";
import { Spinner } from "~/components/shared/spinner";
import { db } from "~/database/db.server";
import { useHapticFeedback } from "~/hooks/use-haptic-feedback";
import { useViewportHeight } from "~/hooks/use-viewport-height";
import {
  CHECKIN_GRADES,
  CHECKIN_INTENT,
  ResolveScanSchema,
} from "~/modules/big-checkin/shared";
import { resolveScannedCode } from "~/modules/big-equipment/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, parseData, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { tw } from "~/utils/tw";

/** Ignore a re-detection of the same code within this window. */
const SAME_CODE_COOLDOWN_MS = 4000;

/** How long the feedback strip stays up after a scan. */
const FLASH_MS = 2200;

export const meta: MetaFunction<typeof loader> = () => [
  { title: appendToMetaTitle("Check in equipment") },
];

export const handle = {
  name: "check-in",
  breadcrumb: () => "Check in",
};

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.checkin,
    });

    return payload({
      header: {
        title: "Check in equipment",
        subHeading:
          "Scan each item as it comes back. Spotted a problem? Photograph it before it goes on the shelf.",
      },
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

/**
 * Resolves one scanned code into an asset the wizard can show.
 *
 * Staff-facing, so unlike the member scanner it does NOT hide non-bookable
 * gear — anything in the workspace can come back over the counter. It reports
 * the asset's current status so the batch can flag "this wasn't out" before the
 * check-in is attempted.
 */
export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.checkin,
    });

    const formData = await request.formData();

    if (formData.get("intent") !== CHECKIN_INTENT.resolve) {
      return data(
        error(
          makeShelfError(new Error("Unsupported action"), {
            userId,
            organizationId,
          })
        ),
        { status: 400 }
      );
    }

    const { value, type } = parseData(formData, ResolveScanSchema, {
      shouldBeCaptured: false,
      additionalData: { userId, organizationId },
    });

    const resolved = await resolveScannedCode({ organizationId, value, type });

    if (resolved.kind !== "asset") {
      return payload({
        scan: { outcome: resolved.kind, value } as const,
      });
    }

    const asset = await db.asset.findFirst({
      where: { id: resolved.assetId, organizationId },
      select: {
        id: true,
        title: true,
        status: true,
        kitId: true,
        thumbnailImage: true,
        mainImage: true,
      },
    });

    if (!asset) {
      return payload({ scan: { outcome: "not-found", value } as const });
    }

    return payload({
      scan: {
        outcome: "asset" as const,
        value,
        asset: {
          id: asset.id,
          title: asset.title,
          status: asset.status,
          isKitMember: Boolean(asset.kitId),
          image: asset.thumbnailImage ?? asset.mainImage ?? null,
        },
      },
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

/** One item in the batch. */
type BatchItem = {
  id: string;
  title: string;
  image: string | null;
  status: string;
  isKitMember: boolean;
  /** Set once a condition report has been filed for it in this session. */
  reported?: { grade: string; note: string };
  /** Set after the batch posts, when this item could not be checked in. */
  failure?: string;
  /** Set after the batch posts, when it was checked in. */
  checkedIn?: boolean;
};

/** The feedback strip's tone + message. */
type Flash = { tone: "success" | "info" | "warn"; text: string };

export default function CheckInWizardPage() {
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
        {() => <CheckInWizard />}
      </ClientOnly>
    </div>
  );
}

/** Client-only: camera + batch state. */
function CheckInWizard() {
  const resolveFetcher = useFetcher<typeof action>({ key: "big-scan-resolve" });
  const deskFetcher = useFetcher<{
    ok?: true;
    results?: { bookingId: string; bookingName: string; assetCount: number }[];
    failures?: { assetId: string; title: string; reason: string }[];
    error?: { message: string };
  }>();

  const { triggerSuccess, triggerError } = useHapticFeedback();

  const [batch, setBatch] = useState<BatchItem[]>([]);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [paused, setPaused] = useState(false);
  /** The asset whose condition report panel is open, if any. */
  const [reportingId, setReportingId] = useState<string | null>(null);

  /** value → last-seen ms, so one label in frame doesn't spam entries. */
  const recentValues = useRef<Map<string, number>>(new Map());
  /** Queued scans while a lookup is in flight (fast sweeps never drop). */
  const pendingScans = useRef<{ value: string; type: string }[]>([]);
  /**
   * Whether a lookup is in flight RIGHT NOW. A ref, not `fetcher.state`:
   * several detections can fire in one tick and the render closure's
   * `fetcher.state` would still read "idle", so each new submit would CANCEL
   * the in-flight one and drop scans.
   */
  const inFlight = useRef(false);
  /** The batch, readable inside effects without re-binding them. */
  const batchRef = useRef(batch);
  batchRef.current = batch;
  /** Results already folded into state — responses are objects, so identity works. */
  const consumedResults = useRef(new WeakSet<object>());

  const { vh, isMd } = useViewportHeight();
  const totalHeight = Math.max(isMd ? vh - 132 : vh - 152, 420);
  const cameraHeight = Math.max(Math.round(totalHeight * 0.44), 220);

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
      void resolveFetcher.submit(
        { intent: CHECKIN_INTENT.resolve, value, type },
        { method: "post" }
      );
    },
    [resolveFetcher]
  );

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

  // Fold each lookup result into the batch, then fire the next queued scan.
  useEffect(() => {
    if (resolveFetcher.state !== "idle") return;

    const advanceQueue = () => {
      const next = pendingScans.current.shift();
      if (next) {
        void resolveFetcher.submit(
          {
            intent: CHECKIN_INTENT.resolve,
            value: next.value,
            type: next.type,
          },
          { method: "post" }
        );
      } else {
        inFlight.current = false;
      }
    };

    const result = resolveFetcher.data;
    if (!result || consumedResults.current.has(result)) {
      advanceQueue();
      return;
    }
    consumedResults.current.add(result);

    if ("error" in result && result.error) {
      triggerError();
      setFlash({ tone: "warn", text: result.error.message });
    } else if ("scan" in result && result.scan) {
      const scan = result.scan;

      if (scan.outcome === "asset" && "asset" in scan && scan.asset) {
        const asset = scan.asset;

        if (batchRef.current.some((item) => item.id === asset.id)) {
          setFlash({ tone: "info", text: `${asset.title} is already scanned` });
        } else if (asset.status !== "CHECKED_OUT") {
          // Surfaced immediately rather than at submit time: staff can put it
          // straight back on the shelf instead of waiting for a failure list.
          triggerError();
          setFlash({
            tone: "warn",
            text: `${asset.title} isn't checked out`,
          });
        } else {
          setBatch((current) => [
            {
              id: asset.id,
              title: asset.title,
              image: asset.image,
              status: asset.status,
              isKitMember: asset.isKitMember,
            },
            ...current,
          ]);
          triggerSuccess();
          setFlash({ tone: "success", text: `Scanned: ${asset.title}` });
        }
      } else if (scan.outcome === "kit") {
        triggerError();
        setFlash({
          tone: "info",
          text: "That's a kit label — check kits in from their booking page",
        });
      } else {
        triggerError();
        setFlash({ tone: "warn", text: "Code not recognized" });
      }
    }

    advanceQueue();
  }, [
    resolveFetcher,
    resolveFetcher.state,
    resolveFetcher.data,
    triggerSuccess,
    triggerError,
  ]);

  // Fold the batch check-in result back into the rows.
  useEffect(() => {
    if (deskFetcher.state !== "idle" || !deskFetcher.data) return;
    const result = deskFetcher.data;
    if (consumedResults.current.has(result)) return;
    consumedResults.current.add(result);

    if (result.error) {
      triggerError();
      setFlash({ tone: "warn", text: result.error.message });
      return;
    }

    const failuresById = new Map(
      (result.failures ?? []).map((failure) => [
        failure.assetId,
        failure.reason,
      ])
    );

    setBatch((current) =>
      current.map((item) => ({
        ...item,
        failure: failuresById.get(item.id),
        checkedIn: !failuresById.has(item.id),
      }))
    );

    const checkedIn = batchRef.current.length - failuresById.size;
    triggerSuccess();
    setFlash({
      tone: failuresById.size > 0 ? "info" : "success",
      text:
        failuresById.size > 0
          ? `${checkedIn} checked in, ${failuresById.size} need attention`
          : `${checkedIn} item${checkedIn === 1 ? "" : "s"} checked in`,
    });
  }, [deskFetcher.state, deskFetcher.data, triggerSuccess, triggerError]);

  const pending = batch.filter((item) => !item.checkedIn);
  const isSubmitting = deskFetcher.state !== "idle";

  function handleCheckInAll() {
    if (pending.length === 0) return;
    void deskFetcher.submit(
      {
        intent: "check-in",
        ...Object.fromEntries(
          pending.map((item, index) => [`assetIds[${index}]`, item.id])
        ),
      },
      { method: "post", action: "/api/big-desk" }
    );
  }

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
          backButtonUrl="/home"
        />

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

      {/* The batch */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-white px-4 md:px-0">
        {batch.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">
            Point the camera at each item&apos;s label as it comes back. Tap a
            row to report damage before it goes on the shelf.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {batch.map((item) => (
              <li key={item.id} className="py-3">
                <div className="flex items-center gap-3">
                  {item.image ? (
                    <img
                      src={item.image}
                      alt=""
                      className="size-10 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <span className="size-10 shrink-0 rounded bg-gray-100" />
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-900">
                      {item.title}
                    </p>
                    <p className="text-xs text-gray-500">
                      {item.failure ? (
                        <span className="text-error-600">{item.failure}</span>
                      ) : item.checkedIn ? (
                        <span className="text-success-700">Checked in</span>
                      ) : item.reported ? (
                        <span className="text-warning-700">
                          Reported: {item.reported.grade.toLowerCase()}
                        </span>
                      ) : (
                        "Ready to check in"
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="p-2"
                      aria-label={`Report a problem with ${item.title}`}
                      tooltip="Report damage or a problem"
                      onClick={() =>
                        setReportingId(reportingId === item.id ? null : item.id)
                      }
                    >
                      <TriangleAlertIcon className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="p-2"
                      aria-label={`Remove ${item.title} from this batch`}
                      onClick={() =>
                        setBatch((current) =>
                          current.filter((entry) => entry.id !== item.id)
                        )
                      }
                    >
                      <XIcon className="size-4" />
                    </Button>
                  </div>
                </div>

                {reportingId === item.id ? (
                  <ConditionReportPanel
                    assetId={item.id}
                    assetTitle={item.title}
                    onCancel={() => setReportingId(null)}
                    onFiled={(grade, note) => {
                      setBatch((current) =>
                        current.map((entry) =>
                          entry.id === item.id
                            ? { ...entry, reported: { grade, note } }
                            : entry
                        )
                      );
                      setReportingId(null);
                      setFlash({
                        tone: "success",
                        text: `Report filed for ${item.title}`,
                      });
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Sticky footer */}
      <div className="shrink-0 border-t bg-white px-4 py-3 md:px-0">
        <Button
          type="button"
          width="full"
          disabled={pending.length === 0 || isSubmitting}
          onClick={handleCheckInAll}
        >
          {isSubmitting
            ? "Checking in..."
            : pending.length === 0
            ? "Scan something to check in"
            : `Check in ${pending.length} item${
                pending.length === 1 ? "" : "s"
              }`}
        </Button>
      </div>
    </div>
  );
}

/**
 * The inline condition report: grade, note, optional photo.
 *
 * Posts multipart to `/api/big-condition-report` with its own fetcher so the
 * scanner above keeps running — the camera never has to be given up to write
 * something down.
 */
function ConditionReportPanel({
  assetId,
  assetTitle,
  onCancel,
  onFiled,
}: {
  assetId: string;
  assetTitle: string;
  onCancel: () => void;
  onFiled: (grade: string, note: string) => void;
}) {
  const fetcher = useFetcher<{ ok?: true; error?: { message: string } }>();
  const [grade, setGrade] = useState(CHECKIN_GRADES[1].value);
  const [note, setNote] = useState("");
  const submitting = fetcher.state !== "idle";
  const filedRef = useRef(false);

  useEffect(() => {
    if (fetcher.state !== "idle" || filedRef.current) return;
    if (fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      filedRef.current = true;
      onFiled(grade, note);
    }
  }, [fetcher.state, fetcher.data, grade, note, onFiled]);

  return (
    <fetcher.Form
      method="post"
      action={`/api/big-condition-report?assetId=${encodeURIComponent(
        assetId
      )}`}
      encType="multipart/form-data"
      className="mt-3 rounded-lg border border-warning-200 bg-warning-25 p-3"
    >
      <p className="mb-2 text-sm font-semibold text-gray-900">
        What&apos;s wrong with {assetTitle}?
      </p>

      {/* Damage is the reason this panel is open, so the entry type is fixed —
          one fewer decision at the counter. */}
      <input type="hidden" name="type" value={AssetConditionType.DAMAGE} />

      <div className="mb-3 grid grid-cols-2 gap-2">
        {CHECKIN_GRADES.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setGrade(option.value)}
            aria-pressed={grade === option.value}
            className={tw(
              "rounded-md border px-3 py-2 text-left text-xs transition",
              grade === option.value
                ? "border-primary-500 bg-primary-50"
                : "border-gray-300 bg-white hover:bg-gray-50"
            )}
          >
            <span className="block font-semibold text-gray-900">
              {option.label}
            </span>
            <span className="block text-gray-500">{option.hint}</span>
          </button>
        ))}
      </div>
      <input type="hidden" name="grade" value={grade} />

      <Input
        label="What happened?"
        name="note"
        required
        value={note}
        onChange={(event) => setNote(event.currentTarget.value)}
        placeholder="e.g. Cracked lens hood, returned without the strap"
        className="mb-3 w-full"
        inputClassName="w-full"
      />

      {/* `capture="environment"` opens the rear camera directly on a phone. */}
      <label className="mb-3 flex cursor-pointer items-center gap-2 rounded border border-dashed border-gray-300 bg-white px-3 py-2 text-sm text-gray-700">
        <CameraIcon className="size-4 text-gray-500" aria-hidden />
        <span>Add a photo (optional)</span>
        <input
          type="file"
          name="image"
          accept="image/*"
          capture="environment"
          className="sr-only"
        />
      </label>

      {fetcher.data?.error ? (
        <p className="mb-2 text-sm text-error-600">
          {fetcher.data.error.message}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          className="flex-1"
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          className="flex-1"
          disabled={submitting || note.trim().length === 0}
        >
          {submitting ? "Saving..." : "File report"}
        </Button>
      </div>
    </fetcher.Form>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
