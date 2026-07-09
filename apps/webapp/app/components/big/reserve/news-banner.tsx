/**
 * MemberNewsBanner — the member dashboard's rotating news banner.
 *
 * The light-theme twin of the kiosk wallboard's news banner: the same
 * admin-authored announcement lines (`KioskConfig.newsMessages`, managed under
 * Settings → Kiosk) rotating every few seconds with progress dots. Renders
 * nothing when there are no messages.
 *
 * @see {@link file://./../../../routes/kiosk.tsx} — the dark wallboard twin
 * @see {@link file://./../../../routes/_layout+/settings.kiosk.tsx} — where the messages are authored
 * @see {@link file://./../../../modules/big-kiosk-content/shared.ts} — splitKioskNews
 */
import { useEffect, useState } from "react";
import { MegaphoneIcon } from "lucide-react";
import { tw } from "~/utils/tw";

/** How long each news line stays on screen (matches the kiosk). */
const ROTATE_INTERVAL_MS = 7000;

/**
 * The banner.
 *
 * @param props.messages - Announcement lines from `splitKioskNews` (already
 *   trimmed/capped); an empty array hides the banner entirely
 */
export function MemberNewsBanner({ messages }: { messages: string[] }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (messages.length <= 1) return;
    const timer = setInterval(
      () => setIndex((current) => (current + 1) % messages.length),
      ROTATE_INTERVAL_MS
    );
    return () => clearInterval(timer);
  }, [messages.length]);

  if (messages.length === 0) return null;
  // Guard against the list shrinking after a revalidation mid-rotation.
  const active = index % messages.length;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-primary-200 bg-primary-25 px-4 py-2.5">
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary-500 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-white">
        <MegaphoneIcon className="size-3.5" aria-hidden />
        News
      </span>
      <p className="line-clamp-2 min-w-0 flex-1 text-sm font-medium text-gray-800">
        {messages[active]}
      </p>
      {messages.length > 1 ? (
        <div className="flex shrink-0 gap-1.5" aria-hidden>
          {messages.map((message, dot) => (
            <span
              key={message}
              className={tw(
                "size-1.5 rounded-full",
                dot === active ? "bg-primary-500" : "bg-primary-200"
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
