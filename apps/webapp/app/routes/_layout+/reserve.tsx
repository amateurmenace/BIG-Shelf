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
import { data, Link, Outlet } from "react-router";
import { ErrorContent } from "~/components/errors";
import { requireMemberPortalAccess } from "~/modules/big-member/service.server";
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
 * @throws {Response} Redirect to `/bookings` for non-portal roles
 * @throws {ShelfError} 403 when booking read permission is missing
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

    return payload(null);
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
 * Member portal section layout component. Renders the matched portal page.
 */
export default function MemberPortalSection() {
  return <Outlet />;
}

export const ErrorBoundary = () => <ErrorContent />;
