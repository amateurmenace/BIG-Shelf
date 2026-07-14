/**
 * Member Portal Section Layout — `/reserve`
 *
 * Thin layout route for the BIG member self-service portal. Members
 * (provisioned from Neon CRM) land here on login — see the redirect in
 * `home.tsx` — instead of the admin dashboard, which they cannot read.
 *
 * The portal is a small multi-page app rendered in this route's `<Outlet/>`:
 * - `/reserve` — the member home dashboard ({@link file://./reserve._index.tsx})
 * - `/reserve/equipment` — browse + reserve equipment ({@link file://./reserve.equipment.tsx})
 * - `/reserve/rooms` — pick a room to book ({@link file://./reserve.rooms._index.tsx})
 * - `/reserve/rooms/:roomId` — the room booking form ({@link file://./reserve.rooms.$roomId.tsx})
 *
 * This route only authorizes (the shared {@link requireMemberPortalAccess}
 * gate: MEMBER, or ADMIN/OWNER previewing) and registers the breadcrumb —
 * child routes own their data and headers, and re-establish org scope via
 * their own gate calls (same pattern as `rooms.tsx`).
 *
 * @see {@link file://./../../modules/big-member/service.server.ts} — the shared gate
 */
import type { LoaderFunctionArgs } from "react-router";
import { data, Link, Outlet, useLoaderData } from "react-router";
import { OrderBar } from "~/components/big/reserve/order-bar";
import { ErrorContent } from "~/components/errors";
import { requireMemberPortalAccess } from "~/modules/big-member/service.server";
import { isMemberReservationEligible } from "~/modules/big-neon-auth/service.server";
// Client-safe import: the component renders this string, so it must NOT come
// from the `.server` module (Vite would pull Prisma/Supabase into the browser).
import { MEMBERSHIP_REQUIRED_MESSAGE } from "~/modules/big-neon-auth/shared";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import { PermissionAction } from "~/utils/permissions/permission.data";

/**
 * Meta for the member portal section. Child routes override with their own.
 */
export const meta = () => [{ title: appendToMetaTitle("Member home") }];

/**
 * Section gate: authorize before any portal page renders. Data fetching is
 * left to the child routes.
 *
 * Also resolves whether this member may actually RESERVE, so the portal can say
 * so up front. The hard gate lives in `createBooking` — i.e. at submit — which
 * meant an ineligible member could scan six items, pick a pickup window, tap
 * Reserve, and only then be told their membership isn't active. Same rule
 * (`isMemberReservationEligible`, which staff always pass), surfaced early.
 *
 * @throws {Response} Redirect to `/bookings` for non-portal roles
 * @throws {ShelfError} 403 when booking read permission is missing
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requireMemberPortalAccess({
      userId,
      request,
      action: PermissionAction.read,
    });

    const canReserve = await isMemberReservationEligible({
      userId,
      organizationId,
    });

    return payload({ canReserve });
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

/** Route handle exposing the breadcrumb for the member portal section. */
export const handle = {
  breadcrumb: () => <Link to="/reserve">Member home</Link>,
};

/**
 * Member portal section layout component. Renders the matched portal page
 * plus the floating scan-to-reserve order bar (shows only while the member's
 * cart has items).
 *
 * When the member can't currently reserve, a banner says so on every portal page
 * — so they find out before investing effort in a booking that will be refused.
 */
export default function MemberPortalSection() {
  const { canReserve } = useLoaderData<typeof loader>();

  return (
    <>
      {!canReserve ? (
        <div
          role="status"
          className="mx-4 mt-4 rounded border border-[#FFE082] bg-[#FFF8E1] px-4 py-3 md:mx-6"
        >
          <p className="text-sm font-medium text-gray-800">
            Your BIG membership isn’t active
          </p>
          <p className="mt-1 text-sm text-gray-700">
            {MEMBERSHIP_REQUIRED_MESSAGE}
          </p>
        </div>
      ) : null}
      <Outlet />
      <OrderBar />
    </>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
