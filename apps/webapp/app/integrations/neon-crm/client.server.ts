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
/** Constituent-OAuth token endpoint (org-agnostic host). */
const NEON_OAUTH_TOKEN_URL = "https://app.neoncrm.com/np/oauth/token";
/** The value `Account Current Membership Status` takes for an active member. */
const NEON_ACTIVE_MEMBERSHIP_STATUS = "Active";
/** Output fields we request when resolving a member. */
const MEMBER_OUTPUT_FIELDS = [
  "Account ID",
  "First Name",
  "Last Name",
  "Email 1",
  "Account Current Membership Status",
];

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

  const auth = Buffer.from(`${NEON_ORG_ID}:${NEON_API_KEY}`).toString("base64");

  const response = await fetch(`${NEON_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new ShelfError({
      cause: null,
      message: `Neon API request failed (${response.status})`,
      additionalData: { path, status: response.status },
      label,
    });
  }

  return (await response.json()) as T;
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
    const accountId = toStringOrNull(row?.["Account ID"]);
    if (!row || !accountId) {
      return null;
    }

    return {
      neonAccountId: accountId,
      firstName: toStringOrNull(row["First Name"]),
      lastName: toStringOrNull(row["Last Name"]),
      email: toStringOrNull(row["Email 1"]) ?? email.trim(),
      isActiveMember:
        toStringOrNull(row["Account Current Membership Status"]) ===
        NEON_ACTIVE_MEMBERSHIP_STATUS,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Could not look up the Neon account for that email",
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
      message: "Could not load the Neon account",
      additionalData: { accountId },
      label,
    });
  }
}
