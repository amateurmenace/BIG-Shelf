import { OrganizationRoles } from "@prisma/client";
import type {
  MetaFunction,
  LoaderFunctionArgs,
  LinksFunction,
} from "react-router";
import { data, Link, redirect, useLoaderData } from "react-router";
import AnnouncementBar from "~/components/dashboard/announcement-bar";
import AssetsByStatusChart from "~/components/dashboard/assets-by-status-chart";
import OnboardingChecklist from "~/components/dashboard/checklist";
import CustodiansList from "~/components/dashboard/custodians";
import InventoryValueChart from "~/components/dashboard/inventory-value-chart";
import NewestAssets from "~/components/dashboard/newest-assets";
import { ErrorContent } from "~/components/errors";
import ActiveBookings from "~/components/home/active-bookings";
import AssetGrowthChart from "~/components/home/asset-growth-chart";
import KpiCards from "~/components/home/kpi-cards";
import LocationDistribution from "~/components/home/location-distribution";
import OverdueBookings from "~/components/home/overdue-bookings";
import QuickActions from "~/components/home/quick-actions";
import TodayPanel from "~/components/home/today-panel";
import UpcomingBookings from "~/components/home/upcoming-bookings";
import UpcomingReminders from "~/components/home/upcoming-reminders";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { db } from "~/database/db.server";
import { getUpcomingRemindersForHomePage } from "~/modules/asset-reminder/service.server";
import { getCurrentOrganizationRole } from "~/modules/big-member/service.server";
import { getBookings } from "~/modules/booking/service.server";

import styles from "~/styles/layout/skeleton-loading.css?url";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { getLocale } from "~/utils/client-hints";
import { userPrefs } from "~/utils/cookies.server";
import {
  buildAssetsByStatusChart,
  buildMonthlyGrowthData,
  checklistOptions,
  getCustodiansOrderedByTotalCustodies,
} from "~/utils/dashboard.server";
import { ShelfError, makeShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";
import { parseMarkdownToReact } from "~/utils/md";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, currentOrganization } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.dashboard,
      action: PermissionAction.read,
    });

    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
    twelveMonthsAgo.setDate(1);
    twelveMonthsAgo.setHours(0, 0, 0, 0);

    /**
     * BIG: "today" for the operational KPI row. Computed in the SERVER's local
     * calendar day, which for a single-site lending library (one timezone) is
     * the right day boundary and avoids threading client hints through every
     * count below.
     */
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    // Fetch all data in parallel — targeted queries instead of loading all assets
    const [
      // 1a. Aggregated asset stats
      assetAggregation,
      valueKnownAssets,
      // 1b. Assets by status
      statusGroups,
      // 1c. Monthly growth data
      monthlyRows,
      baselineCount,
      // 1d. Top custodians (direct custody)
      directCustodians,
      // 1d. Bookings for custodian merge (ongoing + overdue)
      { bookings: ongoingAndOverdueBookings },
      // Upcoming bookings
      { bookings: upcomingBookings },
      // Overdue bookings
      { bookings: overdueBookings },
      // Active/ongoing bookings
      { bookings: activeBookings },
      // 1e. Newest 5 assets
      newAssets,
      // Upcoming reminders
      upcomingReminders,
      // Announcement
      announcement,
      // KPI counts
      teamMembersCount,
      locationDistribution,
      locationsCount,
      categoriesCount,
      // BIG: operational "right now" counts for the dashboard's KPI row
      assetsOutCount,
      dueBackTodayCount,
      pickingUpTodayCount,
      overdueBookingsCount,
      // Cookie
      cookieResult,
    ] = await Promise.all([
      // 1a. Asset count + total valuation
      db.asset
        .aggregate({
          where: { organizationId },
          _count: { _all: true },
          _sum: { valuation: true },
        })
        .catch((cause) => {
          throw new ShelfError({
            cause,
            message: "Failed to load asset aggregation",
            additionalData: { userId, organizationId },
            label: "Dashboard",
          });
        }),

      // 1a. Count of assets with known valuation
      db.asset.count({
        where: { organizationId, valuation: { not: null } },
      }),

      // 1b. Assets grouped by status
      db.asset.groupBy({
        by: ["status"],
        where: { organizationId },
        _count: { _all: true },
      }),

      // 1c. Monthly asset creation counts (last 12 months)
      db.$queryRaw<{ month_start: Date; assets_created: number }[]>`
        SELECT date_trunc('month', "createdAt") AS month_start,
               COUNT(*)::int AS assets_created
        FROM "Asset"
        WHERE "organizationId" = ${organizationId}
          AND "createdAt" >= ${twelveMonthsAgo}
        GROUP BY 1
        ORDER BY 1`,

      // 1c. Baseline count (assets before the 12-month window)
      db.asset.count({
        where: { organizationId, createdAt: { lt: twelveMonthsAgo } },
      }),

      // 1d. Team members with direct custody counts
      db.teamMember.findMany({
        where: { organizationId, custodies: { some: {} } },
        include: {
          user: {
            select: {
              firstName: true,
              lastName: true,
              displayName: true,
              profilePicture: true,
              email: true,
            },
          },
          _count: { select: { custodies: true } },
        },
        orderBy: { custodies: { _count: "desc" } },
        take: 20,
      }),

      // 1d. Ongoing + overdue bookings for custodian merge
      getBookings({
        organizationId,
        userId,
        page: 1,
        perPage: 1000,
        statuses: ["ONGOING", "OVERDUE"],
        extraInclude: {
          custodianTeamMember: true,
          custodianUser: true,
          _count: { select: { assets: true } },
        },
      }),

      // Upcoming bookings (RESERVED, starting from now)
      // Both bookingFrom and bookingTo are required for date filtering
      getBookings({
        organizationId,
        userId,
        page: 1,
        perPage: 5,
        statuses: ["RESERVED"],
        bookingFrom: new Date(),
        bookingTo: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        extraInclude: {
          custodianTeamMember: true,
          custodianUser: true,
          _count: { select: { assets: true } },
        },
      }),

      // Overdue bookings
      getBookings({
        organizationId,
        userId,
        page: 1,
        perPage: 5,
        statuses: ["OVERDUE"],
        extraInclude: {
          custodianTeamMember: true,
          custodianUser: true,
          _count: { select: { assets: true } },
        },
      }),

      // Active/ongoing bookings
      getBookings({
        organizationId,
        userId,
        page: 1,
        perPage: 5,
        statuses: ["ONGOING"],
        extraInclude: {
          custodianTeamMember: true,
          custodianUser: true,
          _count: { select: { assets: true } },
        },
      }),

      // 1e. Newest 5 assets
      db.asset
        .findMany({
          where: { organizationId },
          orderBy: { createdAt: "desc" },
          take: 5,
          include: { category: true },
        })
        .catch((cause) => {
          throw new ShelfError({
            cause,
            message: "Failed to load newest assets",
            additionalData: { userId, organizationId },
            label: "Dashboard",
          });
        }),

      // Upcoming reminders
      getUpcomingRemindersForHomePage({ organizationId }),

      // Announcement
      db.announcement
        .findFirst({
          where: { published: true },
          orderBy: { createdAt: "desc" },
        })
        .catch((cause) => {
          throw new ShelfError({
            cause,
            message: "Failed to load announcement",
            additionalData: { userId, organizationId },
            label: "Dashboard",
          });
        }),

      // KPI: team members
      db.teamMember.count({
        where: { organizationId, deletedAt: null },
      }),

      // Location distribution (top 5)
      db.location
        .findMany({
          where: { organizationId },
          select: {
            id: true,
            name: true,
            _count: { select: { assets: true } },
          },
          orderBy: { assets: { _count: "desc" } },
          take: 5,
        })
        .then((locs) =>
          locs
            .filter((l) => l._count.assets > 0)
            .map((l) => ({
              locationId: l.id,
              locationName: l.name,
              assetCount: l._count.assets,
            }))
        ),

      // KPI: total locations
      db.location.count({
        where: { organizationId },
      }),

      // KPI: total categories
      db.category.count({
        where: { organizationId },
      }),

      // BIG: how much gear is out of the building right now.
      db.asset.count({
        where: { organizationId, status: "CHECKED_OUT" },
      }),

      // BIG: bookings due back before midnight tonight — today's returns desk.
      db.booking.count({
        where: {
          organizationId,
          status: { in: ["ONGOING", "OVERDUE"] },
          to: { gte: todayStart, lt: todayEnd },
        },
      }),

      // BIG: reservations being collected today — today's pick list.
      db.booking.count({
        where: {
          organizationId,
          status: "RESERVED",
          from: { gte: todayStart, lt: todayEnd },
        },
      }),

      // BIG: overdue right now. The one number worth interrupting someone for.
      db.booking.count({
        where: { organizationId, status: "OVERDUE" },
      }),

      // Cookie
      userPrefs.parse(request.headers.get("Cookie")).then((c: any) => c || {}),
    ]);

    const totalAssets = assetAggregation._count._all;
    const totalValuation = assetAggregation._sum.valuation ?? 0;

    const header: HeaderData = {
      title: "Home",
    };

    return payload({
      header,
      // KPI data
      totalAssets,
      teamMembersCount,
      locationsCount,
      categoriesCount,
      // BIG: operational counts driving the "today" KPI row
      assetsOutCount,
      dueBackTodayCount,
      pickingUpTodayCount,
      overdueBookingsCount,
      // Widget data
      upcomingBookings,
      overdueBookings,
      activeBookings,
      upcomingReminders,
      locationDistribution,
      // Existing dashboard data
      locale: getLocale(request),
      currency: currentOrganization?.currency,
      totalValuation,
      valueKnownAssets,
      newAssets,
      skipOnboardingChecklist: cookieResult.skipOnboardingChecklist,
      custodiansData: getCustodiansOrderedByTotalCustodies({
        directCustodians,
        bookings: ongoingAndOverdueBookings as any,
      }),
      assetsByStatus: buildAssetsByStatusChart(statusGroups),
      assetGrowthData: buildMonthlyGrowthData(monthlyRows, baselineCount),
      announcement: announcement
        ? {
            ...announcement,
            content: parseMarkdownToReact(announcement.content),
          }
        : null,
      checklistOptions: await checklistOptions({
        hasAssets: totalAssets > 0,
        organizationId,
      }),
    });
  } catch (cause) {
    // BIG: MEMBER (like BASE / SELF_SERVICE) lacks `dashboard:read`, so
    // requirePermission 403s them on the app's default landing (/home). Route
    // members to their reservation portal instead of a dead-end 403. The role
    // is resolved only here on the error path, so admins/owners — who pass
    // requirePermission and never reach this catch — pay no extra lookup.
    const role = await getCurrentOrganizationRole({ userId, request }).catch(
      () => null
    );
    if (role === OrganizationRoles.MEMBER) {
      throw redirect("/reserve");
    }

    const reason = makeShelfError(cause);
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = () => [
  { title: appendToMetaTitle("Home") },
];

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];

export const handle = {
  breadcrumb: () => <Link to="/home">Home</Link>,
};

export default function HomePage() {
  const { skipOnboardingChecklist, checklistOptions } =
    useLoaderData<typeof loader>();
  const completedAllChecks = Object.values(checklistOptions).every(Boolean);

  return (
    <div>
      {/* BIG: quick actions live in the header's top-right so the two things
          staff do most often from the dashboard — start a booking, add an
          asset — are one click away. `/bookings/new` is a full page (the
          CreateBookingDialog needs the bookings-index loader data, which the
          dashboard does not have). */}
      <Header>
        <Button
          to="/assets/new"
          variant="secondary"
          icon="asset"
          className="whitespace-nowrap"
        >
          New asset
        </Button>
        <Button
          to="/bookings/new"
          icon="bookings"
          className="whitespace-nowrap"
        >
          New booking
        </Button>
      </Header>
      {completedAllChecks || skipOnboardingChecklist ? (
        <div className="flex flex-col gap-6 pb-8 pt-4">
          <AnnouncementBar />

          {/*
           * BIG: the dashboard is ordered by urgency, top to bottom.
           *
           * 1. What needs doing today (the four operational counts)
           * 2. How to do it (quick actions)
           * 3. What is happening (the booking pipeline)
           * 4. Everything else — reminders, charts, inventory shape
           *
           * The old inventory KPIs (total assets / categories / locations /
           * team members) moved to the bottom: true, but nobody opens the
           * dashboard to find out how many categories exist.
           */}
          <TodayPanel />

          <QuickActions />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <UpcomingBookings />
            <ActiveBookings />
            <OverdueBookings />
          </div>

          {/* Widget Grid — 3-column rows */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {/* Inventory value + Reminders, Status & Locations */}
            <InventoryValueChart />
            <UpcomingReminders />
            <AssetsByStatusChart />
            <LocationDistribution />
          </div>

          {/* Row: People & Assets — 2-column */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <CustodiansList />
            <NewestAssets />
          </div>

          <AssetGrowthChart />

          {/* Collection shape — reference, not a daily read. */}
          <KpiCards />
        </div>
      ) : (
        <OnboardingChecklist />
      )}
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
