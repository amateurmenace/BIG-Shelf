/**
 * Add BIG Shelf to Your Phone — `/reserve/app`
 *
 * Step-by-step instructions for putting a BIG Shelf icon on the phone's home
 * screen so the member portal opens like an app (the site ships a PWA
 * manifest + standalone display + proper icons, so the installed experience
 * is full-screen with the BIG icon). Detects iPhone vs Android client-side
 * and leads with the right steps; the other platform stays one tap away.
 *
 * @see {@link file://./../../root.tsx} — manifest + apple-touch-icon links
 * @see {@link file://./../../../public/static/manifest.json}
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  CheckCircle2Icon,
  EllipsisVerticalIcon,
  PlusSquareIcon,
  ShareIcon,
  SmartphoneIcon,
} from "lucide-react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data } from "react-router";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import { requireMemberPortalAccess } from "~/modules/big-member/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import { PermissionAction } from "~/utils/permissions/permission.data";
import { tw } from "~/utils/tw";

/** Gate only — the page is static instructions. */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    await requireMemberPortalAccess({
      userId,
      request,
      action: PermissionAction.read,
    });
    return payload({ header: { title: "Add BIG Shelf to your phone" } });
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: appendToMetaTitle(loaderData?.header.title) },
];

export const handle = {
  breadcrumb: () => "single",
  name: "reserve.app",
};

type Platform = "ios" | "android";

/** One numbered step row. */
function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-700">
        {n}
      </span>
      <span className="text-sm text-gray-700">{children}</span>
    </li>
  );
}

/**
 * The instructions page.
 */
export default function AddToPhonePage() {
  // Default to iOS; swap to Android when the user agent says so. Runs after
  // hydration only, so SSR and the first client render always agree.
  const [platform, setPlatform] = useState<Platform>("ios");
  useEffect(() => {
    if (/android/i.test(navigator.userAgent)) {
      setPlatform("android");
    }
  }, []);

  return (
    <div>
      <Header />

      <div className="mx-auto flex max-w-xl flex-col gap-4 p-4 md:gap-6 md:p-6">
        <div className="rounded-lg border border-gray-200 bg-white p-5 text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-gray-200 bg-white shadow-sm">
            <img
              src="/static/images/big/app-icon-180.png"
              alt="The BIG Shelf app icon"
              className="size-12 rounded-xl"
            />
          </span>
          <h1 className="mt-3 text-lg font-semibold text-gray-900">
            Use BIG Shelf like an app
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Add it to your home screen and it opens full-screen with its own
            icon — one tap from reserving gear or scanning a label. No app store
            needed.
          </p>
        </div>

        {/* Platform switch */}
        <div
          className="grid grid-cols-2 gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1"
          role="tablist"
          aria-label="Choose your phone"
        >
          {(
            [
              { key: "ios", label: "iPhone / iPad" },
              { key: "android", label: "Android" },
            ] as const
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={platform === option.key}
              onClick={() => setPlatform(option.key)}
              className={tw(
                "rounded-md py-2 text-sm font-medium transition",
                platform === option.key
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {platform === "ios" ? (
          <div className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
              <SmartphoneIcon className="size-4 text-primary-600" aria-hidden />
              On iPhone or iPad (Safari)
            </h2>
            <ol className="flex flex-col gap-3">
              <Step n={1}>
                Open <span className="font-medium">this site in Safari</span>{" "}
                (Add to Home Screen isn&apos;t available from inside other
                apps&apos; browsers).
              </Step>
              <Step n={2}>
                Tap the{" "}
                <span className="inline-flex items-center gap-1 font-medium">
                  Share button
                  <ShareIcon className="size-4 text-blue-600" aria-hidden />
                </span>{" "}
                at the bottom of the screen.
              </Step>
              <Step n={3}>
                Scroll down and tap{" "}
                <span className="inline-flex items-center gap-1 font-medium">
                  Add to Home Screen
                  <PlusSquareIcon className="size-4" aria-hidden />
                </span>
                .
              </Step>
              <Step n={4}>
                Tap <span className="font-medium">Add</span> — the BIG Shelf
                icon appears on your home screen.
              </Step>
            </ol>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
              <SmartphoneIcon className="size-4 text-primary-600" aria-hidden />
              On Android (Chrome)
            </h2>
            <ol className="flex flex-col gap-3">
              <Step n={1}>
                Open <span className="font-medium">this site in Chrome</span>.
              </Step>
              <Step n={2}>
                Tap the{" "}
                <span className="inline-flex items-center gap-1 font-medium">
                  menu
                  <EllipsisVerticalIcon className="size-4" aria-hidden />
                </span>{" "}
                in the top-right corner.
              </Step>
              <Step n={3}>
                Tap <span className="font-medium">Add to Home screen</span> (on
                some phones it says{" "}
                <span className="font-medium">Install app</span>).
              </Step>
              <Step n={4}>
                Confirm — the BIG Shelf icon appears on your home screen.
              </Step>
            </ol>
          </div>
        )}

        <div className="flex items-start gap-2 rounded-lg border border-success-200 bg-success-50 p-3 text-sm text-success-700">
          <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Once added, BIG Shelf opens full-screen — straight to your member
            home, with scanning one tap away.
          </span>
        </div>
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
