import { OrganizationRoles } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";
import { loader } from "~/routes/api+/big-reservable-people";
import { listReservablePeople } from "~/modules/big-member-directory/service.server";
import { requirePermission } from "~/utils/roles.server";

// why: the route's job is the permission decision; stub who is asking.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: vi.fn(),
}));

// why: listing logic is covered by the service's own tests; here we only need
// to know whether the route handed the list out at all.
vi.mock("~/modules/big-member-directory/service.server", () => ({
  listReservablePeople: vi.fn(),
}));

const requirePermissionMock = vi.mocked(requirePermission);
const listMock = vi.mocked(listReservablePeople);

const PEOPLE = [
  {
    id: "neon:ava@example.com",
    name: "Ava Whitfield",
    email: "ava@example.com",
    userId: null,
    hasAccount: false,
  },
];

function callLoader() {
  return loader(
    createLoaderArgs({
      request: new Request("http://localhost:3000/api/big-reservable-people"),
      context: { getSession: () => ({ userId: "user-1" }) } as any,
    })
  ) as Promise<any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue(PEOPLE);
});

describe("GET /api/big-reservable-people", () => {
  it("gives staff the complete list for their organization", async () => {
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-big",
      role: OrganizationRoles.ADMIN,
      isSelfServiceOrBase: false,
    } as any);

    const response = await callLoader();

    expect(listMock).toHaveBeenCalledWith({ organizationId: "org-big" });
    expect(response.data).toEqual({ error: null, people: PEOPLE });
  });

  it.each([
    OrganizationRoles.MEMBER,
    OrganizationRoles.SELF_SERVICE,
    OrganizationRoles.BASE,
  ])(
    "refuses %s users — the list holds every member's email address",
    async (role) => {
      requirePermissionMock.mockResolvedValue({
        organizationId: "org-big",
        role,
        isSelfServiceOrBase: true,
      } as any);

      const response = await callLoader();

      expect(response.init?.status).toBe(403);
      expect(listMock).not.toHaveBeenCalled();
    }
  );
});
