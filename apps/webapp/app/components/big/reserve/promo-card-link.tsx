/**
 * PromoCardLink — a kiosk class/event promo as a tappable link card.
 *
 * The member-dashboard twin of the wallboard's promo card: same admin-managed
 * content (`KioskPromo` — uploaded image, title, event date, sign-up URL from
 * Settings → Kiosk), but since members browse on their own devices the wall's
 * "scan to sign up" QR affordance becomes a plain link that opens the sign-up
 * page in a new tab.
 *
 * @see {@link file://./../../../routes/kiosk.tsx} — the QR-based wallboard twin
 * @see {@link file://./../../../modules/big-kiosk-content/service.server.ts} — the data
 */
import { ArrowUpRightIcon } from "lucide-react";
import { toDT } from "~/components/big/room-booking/schedule";

/** The tight-mapped promo shape the dashboard loader sends. */
export type MemberPromo = {
  id: string;
  title: string;
  eventDate: string | Date | null;
  linkUrl: string;
  imageUrl: string;
};

/**
 * The card: image with a dark scrim, title + date, and a "Sign up" affordance.
 * The whole card is one external link (new tab).
 *
 * @param props.promo - The promo to render
 */
export function PromoCardLink({ promo }: { promo: MemberPromo }) {
  return (
    <a
      href={promo.linkUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block h-36 overflow-hidden rounded-lg border border-gray-200 shadow-sm transition hover:shadow-md"
    >
      <img
        src={promo.imageUrl}
        alt=""
        className="absolute inset-0 size-full object-cover"
      />
      <div
        className="absolute inset-0 bg-gradient-to-t from-gray-950/80 via-gray-950/40 to-gray-950/10"
        aria-hidden
      />
      <div className="relative flex h-full flex-col justify-end p-4 text-white">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-300">
          Happening at BIG
        </p>
        <p className="mt-0.5 line-clamp-2 text-base font-semibold leading-tight">
          {promo.title}
        </p>
        <div className="mt-1 flex items-center justify-between gap-2">
          {promo.eventDate ? (
            <p className="text-sm text-gray-200">
              {/* why: eventDate is stored as UTC midnight of the picked
                  calendar date — format in UTC (not DateS/local zone) or the
                  date shifts a day for viewers west of UTC */}
              {toDT(promo.eventDate).toUTC().toFormat("EEEE, MMMM d")}
            </p>
          ) : (
            <span aria-hidden />
          )}
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-white/90 transition group-hover:text-white">
            Sign up
            <ArrowUpRightIcon className="size-3.5" aria-hidden />
          </span>
        </div>
      </div>
    </a>
  );
}
