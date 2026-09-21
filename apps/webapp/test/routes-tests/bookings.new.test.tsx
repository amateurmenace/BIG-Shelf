import { OrganizationRoles } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShelfError } from "~/utils/error";

import { action } from "~/routes/_layout+/bookings.new";
import { requirePermission } from "~/utils/roles.server";

const dbMocks = vi.hoisted(() => {
  return {
    booking: {
      create: vi.fn(),
    },
  };
});

const memberDirectoryMocks = vi.hoisted(() => ({
  resolveReservationCustodian: vi.fn(),
}));

// why: testing route handler without executing actual database operations
vi.mock("~/database/db.server", () => ({
  db: {
    booking: {
      create: dbMocks.booking.create,
    },
  },
}));

// why: testing authorization logic without executing actual permission checks
vi.mock("~/utils/roles.server", () => ({
  requirePermission: vi.fn(),
}));

// why: testing booking creation validation without executing actual booking service operations
vi.mock("~/modules/booking/service.server", () => ({
  createBooking: vi.fn().mockResolvedValue({
    id: "booking-123",
    from: new Date("2024-01-01T10:00:00Z"),
    to: new Date("2024-01-02T10:00:00Z"),
  }),
}));

// why: testing custodian organization validation without database lookups.
// The route resolves the custodian via the member directory, which org-scopes
// an ordinary team member id and additionally materialises a Neon-only member.
vi.mock("~/modules/big-member-directory/service.server", () => ({
  resolveReservationCustodian: memberDirectoryMocks.resolveReservationCustodian,
}));

// why: testing booking creation without executing tag building logic
vi.mock("~/modules/tag/service.server", () => ({
  buildTagsSet: vi.fn().mockReturnValue({ set: [] }),
}));

// why: preventing actual notification sending during route tests
vi.mock("~/utils/emitter/send-notification.server", () => ({
  sendNotification: vi.fn(),
}));

// why: controlling form data parsing and response formatting for predictable test behavior
vi.mock("~/utils/http.server", () => ({
  assertIsPost: vi.fn(),
  parseData: vi.fn().mockImplementation((formData) => {
    const name = formData.get("name");
    const custodian = JSON.parse(formData.get("custodian") || "{}");
    return {
      name,
      custodian,
      assetIds: [],
      description: null,
      tags: "",
    };
  }),
  data: vi.fn((x) => ({ success: true, ...x })),
  error: vi.fn((x) => ({ error: x })),
  getCurrentSearchParams: vi.fn(() => new URLSearchParams()),
}));

// why: testing booking creation without fetching actual booking settings
vi.mock("~/modules/booking-settings/service.server", () => ({
  getBookingSettingsForOrganization: vi.fn().mockResolvedValue({}),
}));

// why: testing booking creation without fetching actual working hours
vi.mock("~/modules/working-hours/service.server", () => ({
  getWorkingHoursForOrganization: vi.fn().mockResolvedValue({}),
}));

// why: controlling timezone for consistent booking time handling
vi.mock("~/utils/client-hints", () => ({
  getHints: vi.fn(() => ({ timeZone: "UTC" })),
  getClientHint: vi.fn(() => ({ timeZone: "UTC" })),
}));

// why: preventing actual cookie operations during route tests
vi.mock("~/utils/cookies.server", () => ({
  setCookie: vi.fn(),
}));

// why: preventing actual organization cookie setting during route tests
vi.mock("~/modules/organization/context.server", () => ({
  setSelectedOrganizationIdCookie: vi.fn().mockResolvedValue("cookie"),
}));

// why: mocking redirect, json, and data response helpers for testing route handler status codes
vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  const mockResponse = (data: any, init?: { status?: number }) =>
    new Response(JSON.stringify(data), {
      status: init?.status || 200,
      headers: { "Content-Type": "application/json" },
    });
  return {
    ...actual,
    redirect: vi.fn(() => new Response(null, { status: 302 })),
    json: vi.fn(mockResponse),
    data: vi.fn(mockResponse),
  };
});

const requirePermissionMock = vi.mocked(requirePermission);
const mockResolveCustodian = memberDirectoryMocks.resolveReservationCustodian;
const mockBookingCreate = dbMocks.booking.create;

function createActionArgs(
  overrides: Partial<ActionFunctionArgs> = {}
): ActionFunctionArgs {
  return {
    context: {
      getSession: () => ({ userId: "user-123" }),
    },
    request: new Request("https://example.com/bookings/new", {
      method: "POST",
    }),
    params: {},
    ...overrides,
  } as ActionFunctionArgs;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveCustodian.mockReset();
  mockBookingCreate.mockReset();
  requirePermissionMock.mockReset();
});

describe("bookings/new - custodian assignment", () => {
  it("prevents assigning booking to custodians from different organizations", async () => {
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-1",
      role: OrganizationRoles.ADMIN,
      isSelfServiceOrBase: false,
    } as any);

    // Custodian not found due to org filter
    // The directory throws a 404 ShelfError for an id outside the caller's
    // organization; the route surfaces it rather than wrapping it.
    mockResolveCustodian.mockRejectedValue(
      new ShelfError({
        cause: null,
        message: "Member not found",
        label: "Team Member",
        status: 404,
      })
    );

    const formData = new FormData();
    formData.set("name", "Test Booking");
    formData.set("startDate", "2024-01-01T10:00");
    formData.set("endDate", "2024-01-02T10:00");
    formData.set(
      "custodian",
      JSON.stringify({
        id: "foreign-team-member-123",
        name: "Foreign Team Member",
      })
    );

    const request = new Request("https://example.com/bookings/new", {
      method: "POST",
      body: formData,
    });

    const response = await action(createActionArgs({ request }));

    expect((response as Response).status).toBe(404);

    expect(mockResolveCustodian).toHaveBeenCalledWith({
      custodianId: "foreign-team-member-123",
      organizationId: "org-1",
    });

    expect(mockBookingCreate).not.toHaveBeenCalled();
  });

  it("allows assigning booking to custodians from the same organization", async () => {
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-1",
      role: OrganizationRoles.ADMIN,
      isSelfServiceOrBase: false,
    } as any);

    // Valid team member from same org
    mockResolveCustodian.mockResolvedValue({
      id: "team-member-123",
      userId: "user-456",
    });

    const formData = new FormData();
    formData.set("name", "Test Booking");
    formData.set("startDate", "2024-01-01T10:00");
    formData.set("endDate", "2024-01-02T10:00");
    formData.set(
      "custodian",
      JSON.stringify({
        id: "team-member-123",
        name: "Valid Team Member",
      })
    );

    const request = new Request("https://example.com/bookings/new", {
      method: "POST",
      body: formData,
    });

    const response = await action(createActionArgs({ request }));

    expect((response as Response).status).toBe(302); // Redirect on success

    expect(mockResolveCustodian).toHaveBeenCalledWith({
      custodianId: "team-member-123",
      organizationId: "org-1",
    });
  });

  it("redirects scan intent to the booking overview scan assets page", async () => {
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-1",
      role: OrganizationRoles.ADMIN,
      isSelfServiceOrBase: false,
    } as any);

    mockResolveCustodian.mockResolvedValue({
      id: "team-member-123",
      userId: "user-456",
    });

    const formData = new FormData();
    formData.set("name", "Test Booking");
    formData.set("startDate", "2024-01-01T10:00");
    formData.set("endDate", "2024-01-02T10:00");
    formData.set(
      "custodian",
      JSON.stringify({
        id: "team-member-123",
        name: "Valid Team Member",
      })
    );
    formData.set("intent", "scan");

    const request = new Request("https://example.com/bookings/new", {
      method: "POST",
      body: formData,
    });

    const response = await action(createActionArgs({ request }));

    expect((response as Response).status).toBe(302);
    expect(vi.mocked(redirect)).toHaveBeenCalledWith(
      "/bookings/booking-123/overview/scan-assets"
    );
  });

  it("prevents self-service users from assigning booking to other team members", async () => {
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-1",
      role: OrganizationRoles.SELF_SERVICE,
      isSelfServiceOrBase: true,
    } as any);

    // Valid team member from same org, but different user
    mockResolveCustodian.mockResolvedValue({
      id: "team-member-456",
      userId: "other-user-456", // Different from current user
    });

    const formData = new FormData();
    formData.set("name", "Test Booking");
    formData.set("startDate", "2024-01-01T10:00");
    formData.set("endDate", "2024-01-02T10:00");
    formData.set(
      "custodian",
      JSON.stringify({
        id: "team-member-456",
        name: "Other Team Member",
      })
    );

    const request = new Request("https://example.com/bookings/new", {
      method: "POST",
      body: formData,
    });

    const response = await action(createActionArgs({ request }));

    expect((response as Response).status).toBe(500); // ShelfError defaults to 500

    expect(mockBookingCreate).not.toHaveBeenCalled();
  });

  it("allows self-service users to assign booking to themselves", async () => {
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-1",
      role: OrganizationRoles.SELF_SERVICE,
      isSelfServiceOrBase: true,
    } as any);

    // Valid team member from same org, same user
    mockResolveCustodian.mockResolvedValue({
      id: "team-member-123",
      userId: "user-123", // Same as current user
    });

    const formData = new FormData();
    formData.set("name", "Test Booking");
    formData.set("startDate", "2024-01-01T10:00");
    formData.set("endDate", "2024-01-02T10:00");
    formData.set(
      "custodian",
      JSON.stringify({
        id: "team-member-123",
        name: "Self User",
      })
    );

    const request = new Request("https://example.com/bookings/new", {
      method: "POST",
      body: formData,
    });

    const response = await action(createActionArgs({ request }));

    expect((response as Response).status).toBe(302); // Redirect on success
  });

  it("allows BASE role users to assign booking to themselves only", async () => {
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-1",
      role: OrganizationRoles.BASE,
      isSelfServiceOrBase: true,
    } as any);

    // Valid team member from same org, but different user (should fail for BASE role)
    mockResolveCustodian.mockResolvedValue({
      id: "team-member-456",
      userId: "other-user-456", // Different from current user
    });

    const formData = new FormData();
    formData.set("name", "Test Booking");
    formData.set("startDate", "2024-01-01T10:00");
    formData.set("endDate", "2024-01-02T10:00");
    formData.set(
      "custodian",
      JSON.stringify({
        id: "team-member-456",
        name: "Other Team Member",
      })
    );

    const request = new Request("https://example.com/bookings/new", {
      method: "POST",
      body: formData,
    });

    const response = await action(createActionArgs({ request }));

    expect((response as Response).status).toBe(500); // ShelfError for self-assignment restriction

    expect(mockBookingCreate).not.toHaveBeenCalled();
  });
});
