import { OrganizationRoles } from "@prisma/client";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import { NewBookingButton } from "./new-booking-button";

const route = vi.hoisted(() => ({ name: "assets.index" as string }));

// why: the button reads the current route's handle and renders a Link; a
// plain anchor and a fixed route stand in for a full router.
vi.mock("react-router", async () => {
  const actual = (await vi.importActual("react-router")) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    useMatches: () => [{ handle: { name: route.name } }],
    Link: ({ to, children, ...rest }: any) => (
      <a {...rest} href={typeof to === "string" ? to : undefined}>
        {children}
      </a>
    ),
  };
});

// why: roles come from the layout loader; each test sets who is looking.
vi.mock("~/hooks/user-user-role-helper", () => ({
  useUserRoleHelper: vi.fn(),
}));

function as(role: OrganizationRoles) {
  vi.mocked(useUserRoleHelper).mockReturnValue({
    roles: [role],
    isBaseOrSelfService: [
      OrganizationRoles.BASE,
      OrganizationRoles.SELF_SERVICE,
      OrganizationRoles.MEMBER,
    ].includes(role as any),
  } as any);
}

beforeEach(() => {
  route.name = "assets.index";
});

describe("NewBookingButton — in the top right where Quick find was", () => {
  it("takes staff to the booking form", () => {
    as(OrganizationRoles.ADMIN);
    render(<NewBookingButton />);
    expect(screen.getByRole("link", { name: /New booking/ })).toHaveAttribute(
      "href",
      "/bookings/new"
    );
  });

  it("takes members to their reservation portal", () => {
    as(OrganizationRoles.MEMBER);
    render(<NewBookingButton />);
    expect(screen.getByRole("link", { name: /New booking/ })).toHaveAttribute(
      "href",
      "/reserve"
    );
  });

  it("has an accessible name in its compact mobile form", () => {
    as(OrganizationRoles.OWNER);
    render(<NewBookingButton variant="icon" />);
    expect(screen.getByRole("link", { name: "New booking" })).toHaveAttribute(
      "href",
      "/bookings/new"
    );
  });

  it("stays out of the way on the new-booking page and the bookings list", () => {
    as(OrganizationRoles.ADMIN);
    route.name = "bookings.new";
    const { container, rerender } = render(<NewBookingButton />);
    expect(container).toBeEmptyDOMElement();

    route.name = "bookings.index";
    rerender(<NewBookingButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is hidden from anyone who cannot create bookings", () => {
    vi.mocked(useUserRoleHelper).mockReturnValue({
      roles: undefined,
      isBaseOrSelfService: false,
    } as any);
    const { container } = render(<NewBookingButton />);
    expect(container).toBeEmptyDOMElement();
  });
});
