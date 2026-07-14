/**
 * Neon CRM integration (server-only)
 *
 * BIG's members live in Neon CRM (Neon One). This client is the single place we
 * talk to Neon — for two jobs:
 *
 *  1. **"Log in with Neon"** — Neon's constituent OAuth 2.0 (auth-code) flow.
 *     It is NOT OpenID Connect: the token endpoint returns the member's numeric
 *     Neon **Account ID** as the "access_token", nothing more. So the code→token
 *     exchange MUST happen server-side and the Account ID must never be trusted
 *     from the browser.
 *  2. **Membership verification** — the REST API v2 (HTTP Basic auth, Org ID as
 *     username + API key as password) to look a constituent up by email and read
 *     whether they hold an active membership.
 *
 * The v2 field shapes below were verified against BIG's live Neon instance:
 * - Search request: `searchFields: [{ field, operator, value }]`, `outputFields`,
 *   `pagination`; response `{ pagination, searchResults: [{ "Account ID", ... }] }`.
 * - Account detail: `{ individualAccount: { primaryContact: { firstName, lastName,
 *   email1 }, accountCurrentMembershipStatus } }`.
 * - Active-member signal: **`accountCurrentMembershipStatus === "Active"`** (also
 *   available as the searchable/output field "Account Current Membership Status").
 *   NOTE: a membership's own `status` field is the TRANSACTION status
 *   ("SUCCEEDED"), not active/inactive — don't use it for eligibility.
 *
 * Design rules (mirrors the PostHog client): no-op/clear guard when unconfigured,
 * all failures wrapped in `ShelfError`, server-only (`.server.ts`).
 *
 * @see https://developer.neoncrm.com/authenticating-constituents/ (OAuth)
 * @see https://developer.neoncrm.com/api-v2/ (REST API v2)
 */
import {
  NEON_API_KEY,
  NEON_OAUTH_CLIENT_ID,
  NEON_OAUTH_CLIENT_SECRET,
  NEON_ORG_ID,
} from "~/utils/env";
import { ShelfError } from "~/utils/error";

const label = "Neon CRM" as const;

/** Neon REST API v2 base URL (production + sandbox share this host). */
const NEON_API_BASE = "https://api.neoncrm.com/v2";
/**
 * The Neon API version we are written against. Neon defaults an unversioned
 * request to "the latest version", which silently opts us into backwards-
 * incompatible changes; pinning means a Neon upgrade can't reshape our
 * responses without us choosing it.
 */
const NEON_API_VERSION = "2.11";
/** Constituent-OAuth token endpoint (org-agnostic host). */
const NEON_OAUTH_TOKEN_URL = "https://app.neoncrm.com/np/oauth/token";
/** The value `Account Current Membership Status` takes for an active member. */
const NEON_ACTIVE_MEMBERSHIP_STATUS = "Active";
/**
 * Output fields we request when resolving a member. "Account ID" doubles as the
 * sort key for paging — Neon requires `sortColumn` to be one of the requested
 * output fields.
 */
const MEMBER_OUTPUT_FIELDS = [
  "Account ID",
  "First Name",
  "Last Name",
  "Email 1",
  "Account Current Membership Status",
];
/**
 * Sort key for every paged search. Neon documents NO default ordering, so an
 * unsorted multi-page read may return a row on two pages and another on none —
 * silently DROPPING members. Because the sync destructively replaces the
 * allowlist, a dropped member becomes a locked-out member. Always sort.
 */
const MEMBER_SORT_COLUMN = "Account ID";

/**
 * Operator guidance surfaced with a 401. Neon binds an API key to a Neon *user*
 * account: disabling that user, or regenerating the key, invalidates the key
 * instantly and returns this same generic "Api key is invalid" for all of them.
 */
const NEON_401_HINT =
  "Neon rejected the API key. Keys belong to a Neon user account — the key is invalidated if it was regenerated or if that user was disabled. Generate a fresh key in Neon (Settings → User Management → the API user → enable API Access, with the 'Read Account' permission) and update NEON_API_KEY.";

/**
 * A resolved Neon constituent as this app cares about it. `neonAccountId` is
 * Neon's canonical integer id, stored as a string.
 */
export type NeonMember = {
  neonAccountId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  isActiveMember: boolean;
};

/** True when the REST API credentials (Org ID + API key) are configured. */
export function isNeonApiConfigured(): boolean {
  return Boolean(NEON_ORG_ID && NEON_API_KEY);
}

/** True when the constituent-OAuth credentials are configured. */
export function isNeonOAuthConfigured(): boolean {
  return Boolean(
    NEON_ORG_ID && NEON_OAUTH_CLIENT_ID && NEON_OAUTH_CLIENT_SECRET
  );
}

/**
 * Builds the Neon constituent-OAuth authorize URL to redirect the member to.
 * Per-org: the authorize host is the org's own `{org_id}.app.neoncrm.com`.
 *
 * @param args.redirectUri - Our callback URL (must match what's registered in Neon)
 * @param args.state - Opaque CSRF/state token we generate and later verify
 * @returns The absolute URL to redirect the browser to
 * @throws {ShelfError} If OAuth is not configured
 */
export function buildNeonAuthorizeUrl({
  redirectUri,
  state,
}: {
  redirectUri: string;
  state: string;
}): string {
  if (!isNeonOAuthConfigured()) {
    throw new ShelfError({
      cause: null,
      message: "Neon login is not configured",
      label,
      status: 503,
      shouldBeCaptured: false,
    });
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: NEON_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
  });

  return `https://${NEON_ORG_ID}.app.neoncrm.com/np/oauth/auth?${params.toString()}`;
}

/**
 * Exchanges an OAuth authorization `code` for the member's Neon Account ID.
 * Neon's token response is `{"access_token": "<accountId>"}` — the "token" IS
 * the numeric Account ID (no ID token / userinfo). Always call this server-side.
 *
 * @param args.code - The `code` query param Neon returned to our callback
 * @param args.redirectUri - The same redirect URI used to start the flow
 * @returns The member's Neon Account ID as a string
 * @throws {ShelfError} If not configured, the request fails, or no id comes back
 */
export async function exchangeNeonAuthCodeForAccountId({
  code,
  redirectUri,
}: {
  code: string;
  redirectUri: string;
}): Promise<string> {
  if (!isNeonOAuthConfigured()) {
    throw new ShelfError({
      cause: null,
      message: "Neon login is not configured",
      label,
      status: 503,
      shouldBeCaptured: false,
    });
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: NEON_OAUTH_CLIENT_ID,
      client_secret: NEON_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
    });

    const response = await fetch(NEON_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      throw new ShelfError({
        cause: null,
        message: `Neon token exchange failed (${response.status})`,
        additionalData: { status: response.status },
        label,
      });
    }

    const json = (await response.json()) as { access_token?: string | number };
    const accountId = json?.access_token;

    if (accountId === undefined || accountId === null || accountId === "") {
      throw new ShelfError({
        cause: null,
        message: "Neon token response did not include an account id",
        label,
      });
    }

    return String(accountId);
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Could not complete Neon login",
      label,
    });
  }
}

/**
 * Low-level authenticated fetch against the Neon REST API v2 (HTTP Basic:
 * Org ID as username, API key as password). Internal helper.
 *
 * @throws {ShelfError} If not configured or the response is not ok
 */
async function neonApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!isNeonApiConfigured()) {
    throw new ShelfError({
      cause: null,
      message: "Neon API is not configured",
      label,
      status: 503,
      shouldBeCaptured: false,
    });
  }

  // Trim: these arrive from Fly secrets / .env, where a stray trailing newline
  // is easy to introduce and would otherwise produce an indistinguishable
  // "Api key is invalid" 401.
  const auth = Buffer.from(
    `${NEON_ORG_ID.trim()}:${NEON_API_KEY.trim()}`
  ).toString("base64");

  const response = await fetch(`${NEON_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      "NEON-API-VERSION": NEON_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new ShelfError({
      cause: null,
      // Neon's own words, not a generic wrapper — an admin staring at the sync
      // button needs to see "Api key is invalid", not "request failed".
      message: await describeNeonFailure(response),
      additionalData: { path, status: response.status },
      label,
      // A bad credential is an operator problem, not a bug to page on.
      shouldBeCaptured: response.status !== 401 && response.status !== 403,
    });
  }

  return (await response.json()) as T;
}

/**
 * Turns a failed Neon response into a message an admin can act on.
 *
 * Neon reports errors as `[{ "code": "13", "message": "Api key is invalid." }]`.
 * Reading that body is the difference between "Could not list active Neon
 * members" (which tells an operator nothing) and a message that names the dead
 * credential and how to replace it.
 *
 * @param response - The non-ok Neon response
 * @returns A human-readable, operator-actionable failure message
 */
async function describeNeonFailure(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = await response.text();
    const parsed: unknown = JSON.parse(body);
    // Neon returns an ARRAY of {code, message}; fall back to the raw body.
    const errors = Array.isArray(parsed) ? parsed : [parsed];
    detail = errors
      .map((e) => {
        const err = e as { code?: string | number; message?: string };
        return err?.message
          ? `${err.message}${err.code ? ` (Neon code ${err.code})` : ""}`
          : "";
      })
      .filter(Boolean)
      .join("; ")
      .trim();
    if (!detail) {
      detail = body.slice(0, 200);
    }
  } catch {
    // Body unreadable / not JSON — the status alone still beats nothing.
  }

  const base = `Neon API request failed (HTTP ${response.status})${
    detail ? `: ${detail}` : ""
  }`;

  return response.status === 401 ? `${base} — ${NEON_401_HINT}` : base;
}

/** Coerces a nullable/empty value to a trimmed string or null. */
function toStringOrNull(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

/**
 * Maps one `/accounts/search` result row to a {@link NeonMember}. Shared by the
 * single-email lookup and the bulk list so field parsing stays in one place.
 *
 * @param row - A raw `searchResults[i]` object keyed by output-field labels
 * @returns The member, or `null` when the row has no usable Account ID
 */
function mapMemberSearchRow(row: Record<string, unknown>): NeonMember | null {
  const accountId = toStringOrNull(row["Account ID"]);
  if (!accountId) {
    return null;
  }
  return {
    neonAccountId: accountId,
    firstName: toStringOrNull(row["First Name"]),
    lastName: toStringOrNull(row["Last Name"]),
    email: toStringOrNull(row["Email 1"]),
    isActiveMember:
      toStringOrNull(row["Account Current Membership Status"]) ===
      NEON_ACTIVE_MEMBERSHIP_STATUS,
  };
}

/**
 * Resolves a {@link NeonMember} from an email address in a single search call.
 * Used to gate email/password self-signup on a real, active membership.
 *
 * @param email - The email the person is signing up with
 * @returns The resolved member, or `null` if no Neon account matches the email
 * @throws {ShelfError} If the API is not configured or the request fails
 */
export async function resolveNeonMemberByEmail(
  email: string
): Promise<NeonMember | null> {
  try {
    const result = await neonApiFetch<{
      searchResults?: Array<Record<string, unknown>>;
    }>("/accounts/search", {
      method: "POST",
      body: JSON.stringify({
        // "Email" matches any of the constituent's email addresses.
        searchFields: [
          { field: "Email", operator: "EQUAL", value: email.trim() },
        ],
        outputFields: MEMBER_OUTPUT_FIELDS,
        pagination: { currentPage: 0, pageSize: 1 },
      }),
    });

    const row = result?.searchResults?.[0];
    const member = row ? mapMemberSearchRow(row) : null;
    if (!member) {
      return null;
    }

    // Fall back to the queried email if Neon's "Email 1" output is blank.
    return { ...member, email: member.email ?? email.trim() };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: withCauseDetail(
        cause,
        "Could not look up the Neon account for that email"
      ),
      additionalData: { email },
      label,
    });
  }
}

/**
 * Resolves a {@link NeonMember} from an Account ID in a single account-detail
 * call (profile + active-membership status). Used by the "Log in with Neon"
 * callback after the OAuth exchange.
 *
 * @param accountId - The Neon Account ID
 * @returns The resolved member (with `isActiveMember`)
 * @throws {ShelfError} If the API is not configured or the request fails
 */
export async function resolveNeonMemberByAccountId(
  accountId: string
): Promise<NeonMember> {
  try {
    const result = await neonApiFetch<{
      individualAccount?: {
        accountCurrentMembershipStatus?: string | null;
        primaryContact?: {
          firstName?: string | null;
          lastName?: string | null;
          email1?: string | null;
        };
      };
    }>(`/accounts/${encodeURIComponent(accountId)}`);

    const individual = result?.individualAccount;
    const contact = individual?.primaryContact;

    return {
      neonAccountId: accountId,
      firstName: toStringOrNull(contact?.firstName),
      lastName: toStringOrNull(contact?.lastName),
      email: toStringOrNull(contact?.email1),
      isActiveMember:
        toStringOrNull(individual?.accountCurrentMembershipStatus) ===
        NEON_ACTIVE_MEMBERSHIP_STATUS,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: withCauseDetail(cause, "Could not load the Neon account"),
      additionalData: { accountId },
      label,
    });
  }
}

/**
 * The outcome of a bulk active-member pull, including enough bookkeeping for the
 * caller to decide whether the result is COMPLETE enough to destructively
 * replace the allowlist with.
 */
export type NeonActiveMemberList = {
  /** Active members that have an email (deduped by Neon Account ID). */
  members: NeonMember[];
  /** Total matching rows Neon reported, or `null` if it didn't say. */
  totalResults: number | null;
  /** Raw rows we actually read across every page (before filtering). */
  rowsSeen: number;
  /** False when we stopped before reading every page Neon reported. */
  complete: boolean;
};

/**
 * Lists ALL active Neon members by paging through `/accounts/search` filtered on
 * `Account Current Membership Status = "Active"`. Powers the admin "Sync now"
 * bulk pull that refreshes the member allowlist.
 *
 * Pages are read SEQUENTIALLY and with an explicit sort: `/accounts/search` is
 * rate-limited to one concurrent request per org, and Neon guarantees no default
 * ordering, so an unsorted read can skip rows between pages. It also reports
 * `rowsSeen` / `complete` so the caller can refuse to replace the allowlist with
 * a truncated pull (a dropped member is a locked-out member).
 *
 * De-duplicates by Neon Account ID and only returns members that have an email
 * (the key enforcement matches on).
 *
 * @param options.pageSize - Results per page (default 100; Neon's max is 200)
 * @param options.maxPages - Safety cap on pages fetched (default 100 → 10k members)
 * @returns The active members plus completeness bookkeeping
 * @throws {ShelfError} If the API is not configured or a request fails
 */
export async function listActiveNeonMembers(options?: {
  pageSize?: number;
  maxPages?: number;
}): Promise<NeonActiveMemberList> {
  const pageSize = options?.pageSize ?? 100;
  const maxPages = options?.maxPages ?? 100;

  try {
    // Keyed by account id so duplicate rows across pages collapse.
    const byAccountId = new Map<string, NeonMember>();
    let totalResults: number | null = null;
    let rowsSeen = 0;
    let complete = false;

    for (let currentPage = 0; currentPage < maxPages; currentPage++) {
      const result = await neonApiFetch<{
        pagination?: { totalPages?: number; totalResults?: number };
        searchResults?: Array<Record<string, unknown>>;
      }>("/accounts/search", {
        method: "POST",
        body: JSON.stringify({
          searchFields: [
            {
              field: "Account Current Membership Status",
              operator: "EQUAL",
              value: NEON_ACTIVE_MEMBERSHIP_STATUS,
            },
          ],
          outputFields: MEMBER_OUTPUT_FIELDS,
          pagination: {
            currentPage,
            pageSize,
            // Stable ordering — without it Neon may hand us the same row twice
            // and another row never. See MEMBER_SORT_COLUMN.
            sortColumn: MEMBER_SORT_COLUMN,
            sortDirection: "ASC",
          },
        }),
      });

      const rows = result?.searchResults ?? [];
      rowsSeen += rows.length;

      if (typeof result?.pagination?.totalResults === "number") {
        totalResults = result.pagination.totalResults;
      }
      const totalPages = result?.pagination?.totalPages ?? 0;

      for (const row of rows) {
        const member = mapMemberSearchRow(row);
        // Keep only genuinely-active members we can key on by email.
        if (member?.isActiveMember && member.email) {
          byAccountId.set(member.neonAccountId, member);
        }
      }

      // Stop when the page came back short or we've covered all pages. Reaching
      // either means we saw everything Neon had; falling out of the loop on
      // `maxPages` instead leaves `complete` false, and the caller must not
      // destructively replace the allowlist from a truncated read.
      if (
        rows.length < pageSize ||
        (totalPages > 0 && currentPage + 1 >= totalPages)
      ) {
        complete = true;
        break;
      }
    }

    return {
      members: [...byAccountId.values()],
      totalResults,
      rowsSeen,
      complete,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      // Keep Neon's own diagnosis (e.g. "Api key is invalid (Neon code 13)")
      // attached — this message is what the admin UI renders.
      message: withCauseDetail(cause, "Could not list active Neon members"),
      label,
    });
  }
}

/**
 * Prefixes a caller-facing summary onto the underlying failure's message, so
 * re-wrapping an error never hides WHY it failed. Without this, a 401 from Neon
 * surfaced to admins as a bare "Could not list active Neon members".
 *
 * @param cause - The error being wrapped
 * @param summary - The caller-facing summary
 * @returns "summary: underlying detail", or just the summary when there is none
 */
function withCauseDetail(cause: unknown, summary: string): string {
  const detail = cause instanceof Error ? cause.message.trim() : "";
  return detail ? `${summary}: ${detail}` : summary;
}
