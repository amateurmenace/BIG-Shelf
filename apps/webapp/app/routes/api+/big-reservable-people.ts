/**
 * Reservable people endpoint — `GET /api/big-reservable-people`
 *
 * BIG: returns EVERYONE staff can reserve for — staff, members with accounts,
 * and every Neon member who has never logged in — in one response. The
 * "Reserved for" picker loads it once and searches it in the browser.
 *
 * Why one complete list instead of paged server search: the population is
 * small (low hundreds), and the paged path is what hid members before. The
 * upstream picker only asked the server when it believed its first page was
 * incomplete, so once every team member fitted on one page it stopped asking —
 * and never saw the Neon directory at all.
 *
 * Staff only. This returns every member's name and email address; the member
 * portal is deliberately anonymised, and a membership list with contact
 * details is exactly what it exists to withhold.
 *
 * @see {@link file://./../../modules/big-member-directory/service.server.ts}
 * @see {@link file://./../../components/big/member-picker.tsx}
 */
import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { listReservablePeople } from "~/modules/big-member-directory/service.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/**
 * Returns the complete list of people the caller may reserve for.
 *
 * @returns `{ people }` for staff; a 403 for members, self-service and base
 *   users, who can only ever book for themselves.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();

  try {
    const { organizationId, isSelfServiceOrBase } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.create,
    });

    // booking:create alone is not enough — members hold it too, to book for
    // themselves. Reserving for someone else is a staff capability.
    if (isSelfServiceOrBase) {
      throw new ShelfError({
        cause: null,
        title: "Not allowed",
        message: "Only staff can reserve for other people.",
        additionalData: { userId, organizationId },
        status: 403,
        shouldBeCaptured: false,
        label: "Team Member",
      });
    }

    const people = await listReservablePeople({ organizationId });

    return data(payload({ people }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
