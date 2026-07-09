/**
 * Kiosk Wallboard — `/kiosk`
 *
 * A full-screen, dark, 16:9 touch display for the space, laid out as four
 * quadrants that fit one screen without scrolling: the room-schedule timeline
 * (top-left) over the booking cards (bottom-left), and the 7-day picker
 * (top-right) over the closed-days calendar (bottom-right). Designed to run on
 * a wall TV / touchscreen that stays signed in under a STAFF kiosk account.
 *
 * - Lives OUTSIDE `_layout+` so no sidebar/app chrome renders (same pattern
 *   as the `qr+` full-screen routes). Auth is enforced in the loader.
 * - Anonymized: busy blocks say "Reserved" — the payload carries no booking
 *   or member names (counts only), so a public wall leaks nothing.
 * - Day picker: the "Next 7 days" strip drives which day the timeline shows,
 *   so people can book future days from the wall (not just today).
 * - Walk-up booking: tap any free hour → pick a duration → type your
 *   membership email. The action resolves the email to an org member and
 *   books THEM as custodian (the kiosk account is only the creator), reusing
 *   {@link createRoomReservation} — so double-booking is rejected and the
 *   member gets the confirmation email.
 * - Self-refreshing: revalidates every minute; a live clock + "now" line.
 * - Admin-managed content (Settings → Kiosk CMS): a rotating news banner at
 *   the top, up to three class/event promo cards with sign-up QR codes, a
 *   "book equipment" card (with an enlargeable QR), a welcoming "become a
 *   member" card, and a rolling 30-day calendar marking the days BIG is
 *   closed (derived from the org's Working Hours so it matches booking rules).
 *
 * @see {@link file://./_layout+/week-ahead.tsx} — the printable staff twin
 * @see {@link file://./_layout+/settings.kiosk.tsx} — the CMS for the wall content
 * @see {@link file://./../modules/big-room-booking/service.server.ts}
 * @see {@link file://./../modules/big-kiosk-content/service.server.ts}
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MegaphoneIcon } from "lucide-react";
import { DateTime } from "luxon";
import QRCode from "qrcode-generator";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { ClientOnly } from "remix-utils/client-only";
import { z } from "zod";
import type { ClientRoomSchedule } from "~/components/big/room-booking/schedule";
import {
  overlapsAnyWindow,
  toDateTimeLocalValue,
  toDT,
} from "~/components/big/room-booking/schedule";
import { ErrorContent } from "~/components/errors";
import { Spinner } from "~/components/shared/spinner";
import { db } from "~/database/db.server";
import { useDisabled } from "~/hooks/use-disabled";
import {
  getKioskClosedDays,
  getKioskConfig,
  getKioskPromos,
  splitKioskNews,
} from "~/modules/big-kiosk-content/service.server";
import type { KioskClosedDays } from "~/modules/big-kiosk-content/shared";
import {
  createRoomReservation,
  findOrgMemberByEmail,
  getRoomsWithSchedule,
  getWeekAheadDigest,
} from "~/modules/big-room-booking/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { getClientHint, getHints } from "~/utils/client-hints";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, parseData, payload } from "~/utils/http.server";
import { isPersonalOrg } from "~/utils/organization";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { tw } from "~/utils/tw";

/** The visible day window of the timeline board (24h clock). */
const BOARD_START_HOUR = 8;
const BOARD_END_HOUR = 22;
const BOARD_HOURS = BOARD_END_HOUR - BOARD_START_HOUR;

/** Walk-up durations offered on the booking sheet. */
const DURATIONS = [
  { label: "30 min", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "2 hours", minutes: 120 },
  { label: "3 hours", minutes: 180 },
] as const;
const ALLOWED_DURATION_MINUTES: number[] = DURATIONS.map((d) => d.minutes);

/** How often the board re-fetches its data. */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * Loads the anonymized board data. Numbers and time windows only — no
 * booking/member names ever reach this (public) screen.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, currentOrganization } = await requirePermission({
      userId,
      request,
      // The wallboard runs under a staff kiosk account — same audience as
      // the admin dashboard. Members use /reserve on their own devices.
      entity: PermissionEntity.dashboard,
      action: PermissionAction.read,
    });

    const timeZone = getHints(request).timeZone;
    const [rooms, digest, promos, config, closedDays] = await Promise.all([
      getRoomsWithSchedule({ organizationId, horizonDays: 7 }),
      getWeekAheadDigest({ organizationId, timeZone }),
      getKioskPromos({ organizationId }),
      getKioskConfig({ organizationId }),
      getKioskClosedDays({ organizationId }),
    ]);

    return data(
      payload({
        organizationName: currentOrganization.name,
        rooms,
        // Counts only — the digest itself carries names and must not be sent.
        todayCounts: {
          departures: digest.days[0]?.departures.length ?? 0,
          returns: digest.days[0]?.returns.length ?? 0,
        },
        weekCounts: digest.days.map((day) => ({
          date: day.date,
          roomBookings: day.roomBookings.length,
        })),
        // Admin-managed wall content (Settings → Kiosk). Tight-mapped: only
        // what the public display renders.
        promos: promos.map((promo) => ({
          id: promo.id,
          title: promo.title,
          eventDate: promo.eventDate,
          linkUrl: promo.linkUrl,
          imageUrl: promo.imageUrl,
        })),
        // The membership card needs a QR target; without a URL it stays off.
        membership: config?.membershipSignupUrl
          ? {
              headline: config.membershipHeadline,
              blurb: config.membershipBlurb,
              signupUrl: config.membershipSignupUrl,
            }
          : null,
        // Admin-authored news lines for the top banner (empty = hidden).
        newsMessages: splitKioskNews(config?.newsMessages),
        closedDays,
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

/** Walk-up booking submission schema. */
const WalkUpSchema = z.object({
  intent: z.literal("walk-up-book"),
  roomId: z.string().min(1),
  email: z.string().email("Enter a valid email address"),
  /** Slot start as a `datetime-local` wire string in the kiosk's timezone. */
  start: z.string().min(1, "Pick a start time"),
  durationMinutes: z.coerce
    .number()
    .int()
    .refine((minutes) => ALLOWED_DURATION_MINUTES.includes(minutes), {
      message: "Pick one of the offered durations",
    }),
});

/**
 * Books a walk-up reservation: resolves the typed email to an org member (the
 * custodian) and reserves the room for them. Staff-device only — the kiosk
 * account is the booking's creator, exactly like staff booking on someone's
 * behalf in the admin UI.
 */
export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, currentOrganization, isSelfServiceOrBase } =
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.booking,
        action: PermissionAction.create,
      });

    // SECURITY: booking on behalf of an arbitrary email is a staff-mediated
    // act. A restricted account signed into the kiosk must not gain it.
    if (isSelfServiceOrBase) {
      throw new ShelfError({
        cause: null,
        title: "Staff device required",
        message:
          "This display isn't signed in with a staff account, so walk-up booking is disabled.",
        label: "Booking",
        status: 403,
        shouldBeCaptured: false,
      });
    }

    if (isPersonalOrg(currentOrganization)) {
      throw new ShelfError({
        cause: null,
        title: "Not allowed",
        message: "You can't create bookings for personal workspaces.",
        label: "Booking",
        status: 403,
        shouldBeCaptured: false,
      });
    }

    const formData = await request.formData();
    const { roomId, email, start, durationMinutes } = parseData(
      formData,
      WalkUpSchema,
      { shouldBeCaptured: false, additionalData: { userId, organizationId } }
    );

    // Org-scoped room lookup (the id comes from the client).
    const room = await db.room.findFirst({
      where: { id: roomId, organizationId },
      select: { id: true, name: true },
    });
    if (!room) {
      throw new ShelfError({
        cause: null,
        message: "That room no longer exists.",
        additionalData: { roomId, organizationId },
        label: "Room",
        status: 404,
        shouldBeCaptured: false,
      });
    }

    const member = await findOrgMemberByEmail({ organizationId, email });
    if (!member) {
      throw new ShelfError({
        cause: null,
        title: "Email not recognized",
        message:
          "We couldn't find an active membership for that email. Use the email on your BIG account, or ask staff for help.",
        additionalData: { organizationId },
        label: "Booking",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    const hints = getClientHint(request);
    const from = DateTime.fromISO(start, { zone: hints.timeZone });
    if (!from.isValid) {
      throw new ShelfError({
        cause: null,
        message: "That start time couldn't be read. Try the slot again.",
        additionalData: { start },
        label: "Booking",
        status: 400,
        shouldBeCaptured: false,
      });
    }
    // Small grace so "book the slot that started a moment ago" works.
    if (from.toJSDate().getTime() < Date.now() - 5 * 60 * 1000) {
      throw new ShelfError({
        cause: null,
        message: "That time has already passed — tap a later slot.",
        additionalData: { start },
        label: "Booking",
        status: 400,
        shouldBeCaptured: false,
      });
    }
    const to = from.plus({ minutes: durationMinutes });

    await createRoomReservation({
      organizationId,
      roomId: room.id,
      name: `${room.name} — walk-up`,
      description: `Walk-up reservation made at the kiosk for ${member.user.email}.`,
      from: from.toJSDate(),
      to: to.toJSDate(),
      creatorId: userId,
      custodianTeamMemberId: member.teamMember.id,
      custodianUserId: member.user.id,
      hints,
      isSelfServiceOrBase: false,
    });

    return data(
      payload({
        ok: true as const,
        confirmation: {
          roomName: room.name,
          firstName: member.user.firstName ?? member.teamMember.name,
          from: from.toJSDate(),
          to: to.toJSDate(),
        },
      })
    );
  } catch (cause) {
    if (cause instanceof Response) {
      throw cause;
    }
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Wallboard") },
];

/**
 * Static shell + client-only board (everything on it depends on the live
 * clock, so SSR renders just the frame).
 */
export default function KioskPage() {
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-gray-900 text-white">
      <ClientOnly
        fallback={
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        }
      >
        {() => <KioskBoard />}
      </ClientOnly>
    </div>
  );
}

/** The live board: clock, timeline, rail, promo strip, booking sheet. */
function KioskBoard() {
  const {
    organizationName,
    rooms,
    todayCounts,
    weekCounts,
    promos,
    membership,
    newsMessages,
    closedDays,
  } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [now, setNow] = useState(() => DateTime.now());
  // Which day the timeline board shows. Defaults to today; the "Next 7 days"
  // picker changes it so people can book future days from the wall.
  const [selectedDay, setSelectedDay] = useState(() =>
    DateTime.now().startOf("day")
  );
  const [sheet, setSheet] = useState<{
    room: ClientRoomSchedule;
    slotStart: DateTime;
  } | null>(null);

  const isTodaySelected = selectedDay.hasSame(now, "day");

  // Live clock (1s) + data refresh (60s, skipped while a booking is open so
  // a revalidation never yanks the sheet's room object out from under it).
  useEffect(() => {
    const clock = setInterval(() => setNow(DateTime.now()), 1000);
    return () => clearInterval(clock);
  }, []);
  useEffect(() => {
    const refresh = setInterval(() => {
      if (!document.hidden && sheet === null) {
        void revalidator.revalidate();
      }
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(refresh);
  }, [revalidator, sheet]);

  const openSheet = useCallback(
    (room: ClientRoomSchedule, slotStart: DateTime) => {
      // Tapping the in-progress hour means "book from now": clamp the start
      // up to the next 5-minute mark so the server's past-time check (5-min
      // grace) never rejects a walk-up.
      const start =
        slotStart < now
          ? now.plus({ minutes: 5 - (now.minute % 5) }).startOf("minute")
          : slotStart;
      setSheet({ room, slotStart: start });
    },
    [now]
  );
  const closeSheet = useCallback(() => {
    setSheet(null);
    // Pull fresh data so a just-made booking appears immediately.
    void revalidator.revalidate();
  }, [revalidator]);

  // Bottom row holds Book-equipment + (optional) Membership + Equipment-today.
  const bottomCardCount = 2 + (membership ? 1 : 0);

  return (
    <>
      {/* Masthead — the BIG Shelf logo leads; it sits on a white chip so the
          navy/magenta wordmark stays legible on the dark board. */}
      <header className="flex shrink-0 items-center justify-between px-8 pb-3 pt-4">
        <div className="flex items-center gap-5">
          <span className="rounded-2xl bg-white px-5 py-2.5 shadow-lg">
            <img
              src="/static/images/big/big-shelf-full.png"
              alt={organizationName}
              className="h-9 w-auto"
            />
          </span>
          <div>
            <h1 className="text-2xl font-semibold">{organizationName}</h1>
            <p className="text-sm text-gray-400">
              Reserve a room or borrow equipment · walk-ups welcome
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-5xl font-semibold tabular-nums leading-none">
            {now.toFormat("h:mm")}
            <span className="ml-2 text-xl font-normal text-gray-400">
              {now.toFormat("a")}
            </span>
          </p>
          <p className="mt-1 text-sm text-gray-400">
            {now.toFormat("EEEE, MMMM d")}
          </p>
        </div>
      </header>

      {/* News banner — admin-authored updates, rotating (top section) */}
      <NewsBanner messages={newsMessages} />

      {/* Promo strip — up to three classes/events, top billing */}
      {promos.length > 0 ? (
        <div
          className="grid shrink-0 gap-4 px-8 pb-3"
          style={{
            gridTemplateColumns: `repeat(${promos.length}, minmax(0, 1fr))`,
          }}
        >
          {promos.map((promo) => (
            <PromoCard key={promo.id} promo={promo} />
          ))}
        </div>
      ) : null}

      {/* Body — four quadrants:
          left column  = room schedule (top) over the booking cards (bottom),
          right column = day picker (top) over the closed-days calendar
          (bottom-right). A flex ROW (not an auto-sized grid row) so the body
          can never grow taller than the screen — sections shrink and scroll
          internally instead of painting over each other (the v27 TV bug). */}
      <div className="flex min-h-0 flex-1 gap-5 px-8 pb-6">
        {/* Left column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          {/* Timeline board — overflow-hidden so rows can never spill out of
              the card and under the strip below, whatever the screen height */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-gray-800/60 p-5">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
                  Room schedule
                </h2>
                <p className="text-xs text-gray-500">
                  {isTodaySelected
                    ? "Today"
                    : selectedDay.toFormat("EEEE, MMMM d")}{" "}
                  · tap a slot to reserve
                </p>
              </div>
              {!isTodaySelected ? (
                <button
                  type="button"
                  onClick={() => setSelectedDay(now.startOf("day"))}
                  className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium hover:bg-white/20"
                >
                  Back to today
                </button>
              ) : null}
            </div>
            <HourAxis />
            {rooms.length === 0 ? (
              <p className="mt-6 text-gray-400">No rooms configured yet.</p>
            ) : (
              // Scrolls when there are more rooms than fit, so the timeline is
              // never cut off by the cards below and rows never overlap.
              <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
                {rooms.map((room) => (
                  <RoomTimelineRow
                    key={room.id}
                    room={room}
                    selectedDay={selectedDay}
                    now={now}
                    onSlotTap={openSheet}
                  />
                ))}
              </div>
            )}
            <p className="mt-2 shrink-0 text-center text-sm text-gray-500">
              Tap any open slot to reserve it on the spot
            </p>
          </div>

          {/* Bottom cards — compact strip; kept short so the timeline gets
              the vertical space. The width of the room-schedule section. */}
          <div
            className="grid shrink-0 gap-4"
            style={{
              gridTemplateColumns: `repeat(${bottomCardCount}, minmax(0, 1fr))`,
            }}
          >
            <BookEquipmentCard />
            {membership ? <MembershipCard membership={membership} /> : null}
            <EquipmentTodayCard todayCounts={todayCounts} />
          </div>
        </div>

        {/* Right column — day picker (top) + closed-days calendar (bottom) */}
        <div className="flex min-h-0 w-[300px] shrink-0 flex-col gap-4">
          <WeekAtAGlance
            weekCounts={weekCounts}
            selectedDay={selectedDay}
            now={now}
            onSelectDay={setSelectedDay}
          />
          <ClosedDatesCalendar
            closedDays={closedDays}
            now={now}
            className="min-h-0 flex-1 overflow-y-auto"
          />
        </div>
      </div>

      {sheet ? (
        <WalkUpBookingSheet
          room={sheet.room}
          slotStart={sheet.slotStart}
          onClose={closeSheet}
        />
      ) : null}
    </>
  );
}

/** The hour labels across the top of the board (every 2 hours). */
function HourAxis() {
  const labels = [];
  for (let hour = BOARD_START_HOUR; hour <= BOARD_END_HOUR; hour += 2) {
    labels.push(
      <span
        key={hour}
        className="absolute -translate-x-1/2 text-xs tabular-nums text-gray-500"
        style={{ left: `${((hour - BOARD_START_HOUR) / BOARD_HOURS) * 100}%` }}
      >
        {DateTime.fromObject({ hour }).toFormat("ha").toLowerCase()}
      </span>
    );
  }
  // Mirrors the row layout (label column + track) so the labels line up with
  // the tracks below exactly.
  return (
    <div className="flex items-center gap-3">
      <div className="w-40 shrink-0" />
      <div className="relative h-4 flex-1">{labels}</div>
    </div>
  );
}

/**
 * One room's row: name + status on the left, the tappable day track on the
 * right (busy blocks, free hour cells, "now" line). Renders whichever day the
 * board has selected; past-shading and the "now" line only apply to today.
 */
function RoomTimelineRow({
  room,
  selectedDay,
  now,
  onSlotTap,
}: {
  room: ClientRoomSchedule;
  selectedDay: DateTime;
  now: DateTime;
  onSlotTap: (room: ClientRoomSchedule, slotStart: DateTime) => void;
}) {
  const dayStart = selectedDay.startOf("day").plus({ hours: BOARD_START_HOUR });
  const dayEnd = selectedDay.startOf("day").plus({ hours: BOARD_END_HOUR });
  const isToday = selectedDay.hasSame(now, "day");

  /** Busy blocks clamped to the visible window, as % offsets. */
  const blocks = room.busyWindows.flatMap((window) => {
    const from = toDT(window.from);
    const to = toDT(window.to);
    const clampedFrom = from < dayStart ? dayStart : from;
    const clampedTo = to > dayEnd ? dayEnd : to;
    if (clampedTo <= clampedFrom) return [];
    const left =
      (clampedFrom.diff(dayStart, "hours").hours / BOARD_HOURS) * 100;
    const width =
      (clampedTo.diff(clampedFrom, "hours").hours / BOARD_HOURS) * 100;
    return [{ key: window.bookingId, left, width }];
  });

  /** The tappable hour grid: a cell is offered when free (and, today, future). */
  const cells = Array.from({ length: BOARD_HOURS }, (_, index) => {
    const cellStart = dayStart.plus({ hours: index });
    const cellEnd = cellStart.plus({ hours: 1 });
    const isPast = isToday && cellEnd <= now;
    const isFree =
      !isPast && !overlapsAnyWindow(room.busyWindows, cellStart, cellEnd);
    return { cellStart, isFree, isPast };
  });

  // How many reservations fall on the selected day (drives the future-day
  // status text; today keeps the live availability).
  const dayReservationCount = room.busyWindows.filter((window) => {
    const from = toDT(window.from);
    const to = toDT(window.to);
    return from < dayEnd && to > dayStart;
  }).length;

  const isBusyNow = room.availability.state === "busy";
  const statusIsBusy = isToday ? isBusyNow : dayReservationCount > 0;
  const statusText = isToday
    ? isBusyNow
      ? `In use until ${
          room.availability.until
            ? toDT(room.availability.until).toFormat("h:mm a")
            : "later"
        }`
      : room.availability.until
      ? `Free until ${toDT(room.availability.until).toFormat("h:mm a")}`
      : "Free"
    : dayReservationCount > 0
    ? `${dayReservationCount} reservation${
        dayReservationCount === 1 ? "" : "s"
      }`
    : "Open all day";

  const nowOffset = isToday
    ? now.diff(dayStart, "hours").hours / BOARD_HOURS
    : -1;

  return (
    <div className="flex shrink-0 items-center gap-3">
      {/* Identity + status */}
      <div className="w-40 shrink-0">
        <p className="flex items-center gap-2 truncate text-base font-semibold">
          <span
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: room.color }}
            aria-hidden
          />
          {room.name}
        </p>
        <p
          className={tw(
            "mt-0.5 text-xs",
            statusIsBusy ? "text-amber-300" : "text-emerald-300"
          )}
        >
          {statusText}
        </p>
      </div>

      {/* Track */}
      <div className="relative h-12 flex-1 overflow-hidden rounded-lg bg-gray-700/40">
        {/* Free-slot tap targets */}
        <div
          className="absolute inset-0 grid"
          style={{
            gridTemplateColumns: `repeat(${BOARD_HOURS}, minmax(0, 1fr))`,
          }}
        >
          {cells.map(({ cellStart, isFree, isPast }) => (
            <button
              key={cellStart.toISO()}
              type="button"
              disabled={!isFree}
              onClick={() => onSlotTap(room, cellStart)}
              aria-label={`Reserve ${room.name} at ${cellStart.toFormat(
                "h a"
              )}`}
              className={tw(
                "group border-r border-gray-900/40 last:border-r-0",
                isFree ? "cursor-pointer hover:bg-white/10" : "cursor-default",
                isPast ? "bg-gray-900/30" : ""
              )}
            >
              {isFree ? (
                <span className="text-lg text-white/0 transition group-hover:text-white/70">
                  +
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* Busy blocks (visual only — taps land on the grid beneath) */}
        {blocks.map((block) => (
          <div
            key={block.key}
            className="pointer-events-none absolute inset-y-1 flex items-center justify-center overflow-hidden rounded-md px-2"
            style={{
              left: `${block.left}%`,
              width: `${block.width}%`,
              backgroundColor: room.color,
              opacity: 0.85,
            }}
          >
            {block.width > 9 ? (
              <span className="truncate text-xs font-semibold text-white">
                Reserved
              </span>
            ) : null}
          </div>
        ))}

        {/* Now line */}
        {nowOffset >= 0 && nowOffset <= 1 ? (
          <div
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-400"
            style={{ left: `${nowOffset * 100}%` }}
            aria-hidden
          >
            <div className="absolute -left-1 -top-0.5 size-2 rounded-full bg-red-400" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The 7-day picker: room-reservation count per day, and each day is tappable
 * to drive which day the timeline board shows (so people can book ahead).
 */
function WeekAtAGlance({
  weekCounts,
  selectedDay,
  now,
  onSelectDay,
}: {
  weekCounts: { date: string | Date; roomBookings: number }[];
  selectedDay: DateTime;
  now: DateTime;
  onSelectDay: (day: DateTime) => void;
}) {
  return (
    <div className="shrink-0 rounded-2xl bg-gray-800/60 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
        Next 7 days
      </h2>
      <p className="mt-0.5 text-xs text-gray-500">
        Tap a day to view &amp; book it
      </p>
      <div className="mt-3 flex justify-between gap-1">
        {weekCounts.map((day) => {
          const date = toDT(day.date);
          const isToday = date.hasSame(now, "day");
          const isSelected = date.hasSame(selectedDay, "day");
          return (
            <button
              key={date.toISODate()}
              type="button"
              onClick={() => onSelectDay(date.startOf("day"))}
              aria-pressed={isSelected}
              aria-label={`Show ${date.toFormat("cccc, MMMM d")}`}
              className={tw(
                "flex w-10 flex-col items-center rounded-lg py-2 transition",
                isSelected
                  ? "bg-white/20 ring-1 ring-white/50"
                  : "hover:bg-white/10"
              )}
            >
              <span className="text-xs uppercase text-gray-500">
                {date.toFormat("EEEEE")}
              </span>
              <span
                className={tw(
                  "text-sm",
                  isSelected || isToday
                    ? "font-semibold text-white"
                    : "text-gray-300"
                )}
              >
                {date.day}
              </span>
              <span
                className={tw(
                  "mt-1 text-xs tabular-nums",
                  day.roomBookings > 0 ? "text-amber-300" : "text-gray-600"
                )}
              >
                {day.roomBookings > 0 ? day.roomBookings : "·"}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-center text-xs text-gray-500">
        room reservations per day
      </p>
    </div>
  );
}

/** Renders any URL as a scannable QR `<img>` (data URL, no markup injection). */
function QRImage({
  value,
  alt,
  className,
}: {
  value: string;
  alt: string;
  className?: string;
}) {
  const dataUrl = useMemo(() => {
    const qr = QRCode(0, "M");
    qr.addData(value);
    qr.make();
    return qr.createDataURL(6, 2);
  }, [value]);

  return <img src={dataUrl} alt={alt} className={className} />;
}

/** A full-screen QR overlay for easy scanning from across the room. */
function QRModal({
  url,
  title,
  subtitle,
  onClose,
}: {
  url: string;
  title: string;
  subtitle: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex flex-col items-center rounded-2xl bg-white p-8 text-center shadow-2xl"
      >
        <QRImage value={url} alt={`QR code for ${title}`} className="size-72" />
        <p className="mt-4 text-2xl font-semibold text-gray-900">{title}</p>
        <p className="mt-1 text-base text-gray-500">{subtitle}</p>
        <button
          type="button"
          onClick={onClose}
          className="mt-6 h-12 rounded-lg bg-gray-900 px-8 text-base font-medium text-white hover:bg-gray-800"
        >
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * "Book equipment" card — a QR to the member portal plus a button that blows
 * the code up full-screen for easy scanning from across the lobby.
 */
function BookEquipmentCard() {
  const [enlarged, setEnlarged] = useState(false);
  const url = `${window.location.origin}/reserve`;

  return (
    <>
      {/* Compact: whole card taps to enlarge the QR full-screen. */}
      <button
        type="button"
        onClick={() => setEnlarged(true)}
        className="flex h-20 items-center gap-3 rounded-2xl bg-gray-800/60 p-3 text-left transition hover:bg-gray-800"
      >
        <QRImage
          value={url}
          alt="QR code linking to the member reservation portal"
          className="size-14 shrink-0 rounded-md bg-white p-1"
        />
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Book equipment</span>
          <span className="block truncate text-xs text-gray-400">
            Scan to reserve gear · tap to enlarge
          </span>
        </span>
      </button>
      {enlarged ? (
        <QRModal
          url={url}
          title="Book equipment"
          subtitle="Scan with your phone camera to browse and reserve gear"
          onClose={() => setEnlarged(false)}
        />
      ) : null}
    </>
  );
}

/** "Equipment out today" card — going-out / due-back counts (compact). */
function EquipmentTodayCard({
  todayCounts,
}: {
  todayCounts: { departures: number; returns: number };
}) {
  return (
    <div className="flex h-20 items-center justify-between gap-2 rounded-2xl bg-gray-800/60 p-3">
      <span className="text-xs font-semibold uppercase leading-tight tracking-wide text-gray-400">
        Out
        <br />
        today
      </span>
      <div className="flex gap-4">
        <div className="text-center">
          <p className="text-2xl font-semibold tabular-nums leading-none">
            {todayCounts.departures}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">out</p>
        </div>
        <div className="text-center">
          <p className="text-2xl font-semibold tabular-nums leading-none">
            {todayCounts.returns}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">back</p>
        </div>
      </div>
    </div>
  );
}

/**
 * The top news banner — admin-authored announcement lines that rotate every
 * few seconds. Renders nothing when there are no messages.
 */
function NewsBanner({ messages }: { messages: string[] }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (messages.length <= 1) return;
    const timer = setInterval(
      () => setIndex((current) => (current + 1) % messages.length),
      7000
    );
    return () => clearInterval(timer);
  }, [messages.length]);

  if (messages.length === 0) return null;
  const active = index % messages.length;

  return (
    <div className="mx-8 mb-3 flex shrink-0 items-center gap-3 rounded-2xl border border-primary-400/40 bg-primary-500/15 px-5 py-2">
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary-500 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-white">
        <MegaphoneIcon className="size-3.5" aria-hidden />
        News
      </span>
      <p className="min-w-0 flex-1 truncate text-base font-medium text-white">
        {messages[active]}
      </p>
      {messages.length > 1 ? (
        <div className="flex shrink-0 gap-1.5" aria-hidden>
          {messages.map((message, dot) => (
            <span
              key={message}
              className={tw(
                "size-1.5 rounded-full",
                dot === active ? "bg-white" : "bg-white/30"
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One class/event promo card on the bottom strip: the uploaded image with a
 * dark scrim, the title + date, and a QR code so people sign up on their
 * phone right from the wall.
 */
function PromoCard({
  promo,
}: {
  promo: {
    id: string;
    title: string;
    eventDate: string | Date | null;
    linkUrl: string;
    imageUrl: string;
  };
}) {
  return (
    <div className="relative h-28 overflow-hidden rounded-2xl bg-gray-800">
      <img
        src={promo.imageUrl}
        alt=""
        className="absolute inset-0 size-full object-cover"
      />
      <div
        className="absolute inset-0 bg-gradient-to-r from-gray-950/85 via-gray-950/50 to-gray-950/20"
        aria-hidden
      />
      <div className="relative flex h-full items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-300">
            Happening at BIG
          </p>
          <p className="mt-0.5 line-clamp-2 text-lg font-semibold leading-tight">
            {promo.title}
          </p>
          {promo.eventDate ? (
            <p className="mt-0.5 text-sm text-gray-200">
              {/* Stored as UTC midnight of the picked date — format in UTC so
                  the calendar date never shifts across timezones. */}
              {toDT(promo.eventDate).toUTC().toFormat("EEEE, MMMM d")}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1">
          <QRImage
            value={promo.linkUrl}
            alt={`QR code to sign up for ${promo.title}`}
            className="size-16 rounded-lg bg-white p-1"
          />
          <span className="text-xs font-medium text-gray-200">
            Scan to sign up
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The welcoming "become a member" card — BIG-magenta gradient, admin-editable
 * copy, and a QR to the membership sign-up page.
 */
function MembershipCard({
  membership,
}: {
  membership: {
    headline: string | null;
    blurb: string | null;
    signupUrl: string;
  };
}) {
  return (
    <div className="flex h-20 items-center justify-between gap-3 rounded-2xl bg-gradient-to-br from-primary-600 via-primary-500 to-primary-400 p-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-tight">
          {membership.headline ?? "Become a BIG member"}
        </p>
        <p className="mt-0.5 truncate text-xs text-white/90">
          {membership.blurb ??
            "Scan to join — borrow gear, book studios, take classes."}
        </p>
      </div>
      <QRImage
        value={membership.signupUrl}
        alt="QR code to sign up for a membership"
        className="size-14 shrink-0 rounded-md bg-white p-1"
      />
    </div>
  );
}

/**
 * Rolling 30-day calendar marking the days BIG is closed — weekly closures
 * plus holiday overrides, both sourced from the org's Working Hours (one
 * source of truth with booking validation). Weekday-aligned (Sunday-first);
 * cells outside the 30-day window are dimmed. Hidden when Working Hours are
 * off.
 */
function ClosedDatesCalendar({
  closedDays,
  now,
  className,
}: {
  closedDays: KioskClosedDays;
  now: DateTime;
  className?: string;
}) {
  if (!closedDays.enabled) return null;

  const today = now.startOf("day");
  const windowEnd = today.plus({ days: 29 }); // 30 days incl. today
  // Sunday-first grid: Luxon weekday is 1=Mon…7=Sun, so `% 7` maps Sun→0.
  const gridStart = today.minus({ days: today.weekday % 7 });
  const gridEnd = windowEnd.plus({ days: 6 - (windowEnd.weekday % 7) });
  const cellCount = Math.round(gridEnd.diff(gridStart, "days").days) + 1;

  const overrideReasons = new Map(
    closedDays.closedOverrides.map((override) => [
      override.date,
      override.reason,
    ])
  );

  const cells = Array.from({ length: cellCount }, (_, index) => {
    const day = gridStart.plus({ days: index });
    const dateKey = day.toFormat("yyyy-MM-dd");
    const inWindow = day >= today && day <= windowEnd;
    const closed =
      inWindow &&
      (closedDays.weeklyClosedWeekdays.includes(day.weekday % 7) ||
        overrideReasons.has(dateKey));
    return {
      day,
      dateKey,
      inWindow,
      closed,
      isToday: day.hasSame(now, "day"),
      isFirstOfMonth: day.day === 1,
    };
  });

  // Collapse consecutive same-reason closures into ranges ("Aug 1 – 7")
  // so a week-long closure reads as one line, not seven.
  const closureRanges: { start: string; end: string; reason: string | null }[] =
    [];
  for (const closure of closedDays.closedOverrides) {
    const previous = closureRanges[closureRanges.length - 1];
    const isNextDay =
      previous &&
      previous.reason === closure.reason &&
      toDT(`${closure.date}T00:00:00`).diff(
        toDT(`${previous.end}T00:00:00`),
        "days"
      ).days === 1;
    if (isNextDay) {
      previous.end = closure.date;
    } else {
      closureRanges.push({
        start: closure.date,
        end: closure.date,
        reason: closure.reason,
      });
    }
  }
  const upcomingClosures = closureRanges.slice(0, 2);

  return (
    <div className={tw("rounded-2xl bg-gray-800/60 p-5", className)}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          Closed days
        </h2>
        <span className="text-xs text-gray-500">
          {today.toFormat("MMM d")} – {windowEnd.toFormat("MMM d")}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1 text-center">
        {["S", "M", "T", "W", "T", "F", "S"].map((letter, index) => (
          <span key={`${letter}-${index}`} className="text-xs text-gray-500">
            {letter}
          </span>
        ))}
        {cells.map(
          ({ day, dateKey, inWindow, closed, isToday, isFirstOfMonth }) => (
            <span
              key={dateKey}
              title={
                closed
                  ? overrideReasons.get(dateKey) ?? "Closed"
                  : day.toFormat("MMM d")
              }
              className={tw(
                "flex h-6 flex-col items-center justify-center rounded text-xs tabular-nums leading-none",
                closed
                  ? "bg-red-500/20 font-medium text-red-300"
                  : inWindow
                  ? "text-gray-300"
                  : "text-gray-600",
                isToday ? "ring-1 ring-white/60" : ""
              )}
            >
              {/* Month abbreviation on the 1st keeps the rolling window readable */}
              {isFirstOfMonth ? day.toFormat("MMM") : day.day}
            </span>
          )
        )}
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-xs text-gray-500">
        <span
          className="inline-block size-2 rounded-sm bg-red-500/40"
          aria-hidden
        />
        closed
      </div>

      {upcomingClosures.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-xs text-gray-400">
          {upcomingClosures.map((closure) => {
            const start = toDT(`${closure.start}T00:00:00`);
            const end = toDT(`${closure.end}T00:00:00`);
            const label =
              closure.start === closure.end
                ? start.toFormat("MMM d")
                : `${start.toFormat("MMM d")} – ${end.toFormat(
                    start.hasSame(end, "month") ? "d" : "MMM d"
                  )}`;
            return (
              <li key={closure.start}>
                {label}
                {closure.reason ? ` — ${closure.reason}` : ""}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The walk-up booking sheet: slot + duration + membership email → reserved.
 */
function WalkUpBookingSheet({
  room,
  slotStart,
  onClose,
}: {
  room: ClientRoomSchedule;
  slotStart: DateTime;
  onClose: () => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const emailRef = useRef<HTMLInputElement>(null);
  const isSubmitting = useDisabled(fetcher);
  const result = fetcher.data;
  const confirmation =
    result && "ok" in result && result.ok === true
      ? result.confirmation ?? null
      : null;
  const succeeded = confirmation !== null;
  const errorMessage =
    result && "error" in result && result.error ? result.error.message : null;

  // Focus the email field on open (imperative — house a11y rule) and close
  // on Escape.
  useEffect(() => {
    emailRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Auto-dismiss the success panel so the wallboard returns to the schedule.
  useEffect(() => {
    if (!succeeded) return;
    const timer = setTimeout(onClose, 8000);
    return () => clearTimeout(timer);
  }, [succeeded, onClose]);

  /** Disable durations that would collide with the next reservation. */
  const durationFits = useCallback(
    (minutes: number) =>
      !overlapsAnyWindow(
        room.busyWindows,
        slotStart,
        slotStart.plus({ minutes })
      ),
    [room.busyWindows, slotStart]
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Reserve ${room.name}`}
        className="w-full max-w-lg rounded-2xl bg-gray-800 p-6 shadow-2xl"
      >
        {confirmation ? (
          <div className="py-6 text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-emerald-500/20 text-4xl">
              ✓
            </div>
            <h2 className="mt-4 text-2xl font-semibold">
              You&apos;re booked
              {confirmation.firstName ? `, ${confirmation.firstName}` : ""}!
            </h2>
            <p className="mt-2 text-gray-300">
              {confirmation.roomName} ·{" "}
              {toDT(confirmation.from).toFormat("h:mm a")} –{" "}
              {toDT(confirmation.to).toFormat("h:mm a")}
            </p>
            <p className="mt-1 text-sm text-gray-400">
              A confirmation email is on its way.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 h-12 rounded-lg bg-white/10 px-6 text-base font-medium hover:bg-white/20"
            >
              Done
            </button>
          </div>
        ) : (
          <fetcher.Form method="post">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold">{room.name}</h2>
                <p className="mt-0.5 text-gray-300">
                  {slotStart.toFormat("EEEE h:mm a")} start
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Cancel"
                className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
              >
                Cancel
              </button>
            </div>

            {errorMessage ? (
              <div
                role="alert"
                className="mt-4 rounded-lg border border-red-400/40 bg-red-500/10 p-3 text-sm text-red-200"
              >
                {errorMessage}
              </div>
            ) : null}

            <input type="hidden" name="intent" value="walk-up-book" />
            <input type="hidden" name="roomId" value={room.id} />
            <input
              type="hidden"
              name="start"
              value={toDateTimeLocalValue(slotStart)}
            />
            <input
              type="hidden"
              name="durationMinutes"
              value={durationMinutes}
            />

            <fieldset className="mt-5">
              <legend className="text-sm font-medium text-gray-300">
                How long?
              </legend>
              <div className="mt-2 grid grid-cols-4 gap-2">
                {DURATIONS.map((duration) => {
                  const fits = durationFits(duration.minutes);
                  const selected = durationMinutes === duration.minutes;
                  return (
                    <button
                      key={duration.minutes}
                      type="button"
                      disabled={!fits}
                      onClick={() => setDurationMinutes(duration.minutes)}
                      className={tw(
                        "h-14 rounded-lg text-base font-medium transition",
                        selected
                          ? "bg-emerald-500 text-gray-900"
                          : "bg-white/10 hover:bg-white/20",
                        !fits ? "opacity-30 hover:bg-white/10" : ""
                      )}
                      title={
                        fits ? undefined : "Runs into the next reservation"
                      }
                    >
                      {duration.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="mt-5">
              <label
                htmlFor="kiosk-email"
                className="text-sm font-medium text-gray-300"
              >
                Your membership email
              </label>
              <input
                ref={emailRef}
                id="kiosk-email"
                type="email"
                name="email"
                required
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                placeholder="you@example.com"
                className="mt-2 h-14 w-full rounded-lg border border-white/20 bg-gray-900 px-4 text-lg text-white placeholder:text-gray-500 focus:border-emerald-400 focus:outline-none"
              />
              <p className="mt-1.5 text-xs text-gray-400">
                We&apos;ll book it in your name and email you the confirmation.
              </p>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-6 h-14 w-full rounded-lg bg-emerald-500 text-lg font-semibold text-gray-900 transition hover:bg-emerald-400 disabled:opacity-60"
            >
              {isSubmitting ? "Reserving…" : "Reserve it"}
            </button>
          </fetcher.Form>
        )}
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
