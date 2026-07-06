/**
 * Rooms Section Layout Route
 *
 * Thin layout route for the `/rooms` section. Rooms are a first-class,
 * reservable entity that holds equipment (assets) and carries a color for UI
 * highlighting. This route gates the entire section behind the `room:read`
 * permission and renders nested room routes (index, new, detail, etc.) via
 * `<Outlet />`.
 *
 * It intentionally holds no page-specific UI of its own — child routes own
 * their headers and content. The only responsibilities here are: authorize the
 * caller, register the breadcrumb, and provide the section-level meta title and
 * error boundary.
 *
 * @see {@link file://./rooms._index.tsx} — the rooms list page rendered in the Outlet
 * @see {@link file://../../modules/room/service.server.ts} — room service API
 * @see {@link file://./locations.tsx} — the sibling layout this route mirrors
 */

import type { LoaderFunctionArgs } from "react-router";
import { Link, Outlet, data } from "react-router";
import { ErrorContent } from "~/components/errors";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/**
 * Meta for the Rooms section. Sets the browser tab title.
 *
 * @returns Remix meta descriptors with the "Rooms" title appended to the base title
 */
export const meta = () => [{ title: appendToMetaTitle("Rooms") }];

/**
 * Section loader. Authorizes the caller for read access to rooms within their
 * active organization before any nested room route renders.
 *
 * This is a gate only — it returns a minimal payload and leaves data fetching to
 * the child routes (which each re-establish the org scope via their own
 * `requirePermission` call).
 *
 * @param args - Remix loader args
 * @param args.context - Request context providing the auth session
 * @param args.request - The incoming request (used for org/permission resolution)
 * @returns A minimal (null) payload once the caller is authorized
 * @throws {ShelfError} If the user lacks `room:read` permission or is unauthenticated
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    await requirePermission({
      userId: authSession.userId,
      request,
      entity: PermissionEntity.room,
      action: PermissionAction.read,
    });

    return payload(null);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

/**
 * Route handle exposing the breadcrumb for the Rooms section.
 */
export const handle = {
  breadcrumb: () => <Link to="/rooms">Rooms</Link>,
};

/**
 * Rooms section layout component. Renders the matched nested room route.
 *
 * @returns The nested route outlet for the Rooms section
 */
export default function RoomsPage() {
  return <Outlet />;
}

/**
 * Error boundary for the Rooms section. Renders the shared error content when a
 * loader/action in this subtree throws.
 *
 * @returns The shared error content component
 */
export const ErrorBoundary = () => <ErrorContent />;
