export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const fieldNames: Record<string, string> = {
  name: 'Group name', displayName: 'Display name', email: 'Email', password: 'Password',
  'trip.destination': 'Destination', 'trip.checkIn': 'Check-in', 'trip.checkOut': 'Check-out', 'trip.guests': 'Guests',
  maxContributionCents: 'Maximum contribution', earliestCheckInAt: 'Earliest check-in', latestCheckInAt: 'Latest check-in', latestCheckOutAt: 'Latest checkout',
  earliestCheckInDate: 'Earliest arrival date', latestCheckInDate: 'Latest arrival date', latestCheckOutDate: 'Latest departure date',
};
function validationCopy(body: any) {
  const issue = Array.isArray(body?.issues) ? body.issues[0] : undefined;
  if (!issue || !Array.isArray(issue.path) || typeof issue.message !== 'string') return errorCopy[422];
  const path = issue.path.join('.');
  const label = fieldNames[path] || fieldNames[issue.path.at(-1)] || 'Details';
  return `${label}: ${issue.message}.`;
}
const errorCopy: Record<number, string> = {
  401: 'Your session has expired. Open your group invite to join securely again.',
  403: 'This session does not have access to this page.',
  404: 'We couldn’t find this page or offer. Check your link and try again.',
  409: 'The proposal changed. Your previous authorization cannot be used for changed terms. Review the latest state.',
  410: 'This offer or invite has expired. Return to your group for the latest option.',
  422: 'Please check your details and try again.',
  429: 'Please wait a moment before trying again.',
};
// Specific codes take precedence: many unrelated conditions share HTTP 409.
const codeCopy: Record<string, string> = {
  SESSION_REQUIRED: 'Your login session is missing or expired. Sign in again, then Accord will return you to this page.',
  ACCOUNT_REQUIRED: 'This browser has a temporary profile but not a secured account. Create an account or sign in before joining, approving, or paying.',
  INVALID_CREDENTIALS: 'That email or password is incorrect.',
  EMAIL_ALREADY_EXISTS: 'An account already uses this email. Sign in instead.',
  ACCOUNT_ALREADY_SECURED: 'This profile already has sign-in credentials.',
  LOGIN_RATE_LIMITED: 'Too many sign-in attempts. Wait 15 minutes and try again.',
  MEMBERS_NOT_READY: 'Not everyone has confirmed their requirements yet. Accord can search once every member is ready.',
  NO_FEASIBLE_OFFER: 'No current stay meets every confirmed requirement.',
  ROOM_FULL: 'This group is already full.',
  NOT_READY_TO_BOOK: 'Every member must approve their contribution before Accord can fund the shared payment and book.',
  OWN_CONSTRAINT_FAILED: 'This proposal doesn’t meet one of your own requirements, so it can’t be approved from your account.',
  CONSTRAINTS_REQUIRED: 'Confirm your requirements in your private space first.',
  OFFER_VERSION_MISMATCH: 'This offer changed since you loaded it. Refresh to see the latest version.',
  OFFER_CHANGED: 'The stay changed while Accord was checking it. Refresh to see the current options.',
  OFFER_NOT_IN_ROOM: 'That demo offer is not part of this group’s current search results.',
  INVITE_NOT_FOUND: 'This invitation is invalid or no longer available. Ask the group host for the current link.',
  ROOM_NOT_FOUND: 'This group no longer exists or the link is incorrect.',
  ROOM_ACCESS_DENIED: 'Your account is not a member of this group. Use its invitation link to join.',
  MERCHANT_BOOKING_FAILED: 'The demo merchant couldn’t complete the booking. No payment or booking success has been confirmed.',
  PERSISTENCE_UNAVAILABLE: 'Accord couldn’t save this change. Please try again. No success has been confirmed.',
  MEMBER_ALREADY_READY: 'This member has already confirmed their requirements, so they can’t be removed.',
  CANNOT_REMOVE_HOST: 'The host can’t be removed from the group.',
  MEMBER_NOT_FOUND: 'This member is no longer in the group.',
  ADMIN_ACCESS_DENIED: 'Only the group host can do that.',
  PROPOSAL_STALE: 'Something changed since this was approved: the price, the terms, or the group. Previous approvals can’t be used. Review the latest state.',
  STAY_SEARCH_UNAVAILABLE: 'Live stay search isn’t configured on this server.',
  VOTING_CLOSED: 'Voting has closed or the group changed. Refresh to see the latest plan.',
  OPTION_NOT_FOUND: 'That trip is no longer on the shortlist. Refresh to see the latest plan.',
  TRIP_NOT_DECIDED: 'The group hasn’t picked where and when yet.',
  STAY_SEARCH_FAILED: 'The live stay providers didn’t respond. Please try again in a moment.',
  BOOKING_PROVIDER_UNAVAILABLE: 'The booking provider couldn’t be reached, so nothing was booked. Please try again.',
  PAYMENT_PROVIDER_UNAVAILABLE: 'CyberSource sandbox is not configured. Add the merchant ID, key ID, shared secret, and sandbox card settings, then try again.',
  PAYMENT_AUTHORIZATION_FAILED: 'CyberSource could not authorize the shared group total. No hotel was booked.',
  PAYMENT_CAPTURE_FAILED: 'The hotel sandbox reservation succeeded, but the shared CyberSource capture needs review in Business Center.',
  HOST_CANNOT_LEAVE: 'The host can’t leave the group.',
  ALREADY_BOOKED: 'This group has already booked.',
  TRIP_IN_PAST: 'Choose trip dates in the future.',
  DATES_REQUIRED: 'Add at least one stretch of dates you could travel. Accord plans the trip around everyone’s dates.',
  NUDGE_NOT_FOUND: 'This message is no longer available.',
  NUDGE_CLOSED: 'You already answered this, or your requirements changed since. Nothing else was changed.',
  AI_UNAVAILABLE: 'Accord can’t reply right now. Try again in a moment.',
};
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(options.headers);
    if (!(options.body instanceof FormData) && options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    response = await fetch(`/api${path}`, { ...options, credentials: 'same-origin', cache: 'no-store', headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'OFFLINE', 'We couldn’t reach Accord. Check your connection and try again. No success has been confirmed.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = typeof body.code === 'string' ? body.code : 'REQUEST_FAILED';
    const message = code === 'VALIDATION_FAILED' ? validationCopy(body) : codeCopy[code] || errorCopy[response.status] || 'Accord couldn’t complete this request. No payment or booking success has been confirmed.';
    throw new ApiError(response.status, code, message);
  }
  if (response.status === 204) return undefined as T;
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError(502, 'INVALID_RESPONSE', 'Accord’s service is not connected yet. Please try again when it is available.');
  }
  return response.json() as Promise<T>;
}
export function post<T>(path: string, body: unknown = {}, headers?: HeadersInit) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body), headers });
}
export const segment = (value: string) => encodeURIComponent(value);
export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
export const date = (value: string, timeZone = 'America/New_York') => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone }).format(new Date(value));
export const calendarDate = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
export const dateTime = (value: string, timeZone = 'America/New_York') => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(new Date(value));
export function safeExplorer(url?: string) {
  if (!url) return undefined;
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'explorer.solana.com' && parsed.pathname.startsWith('/tx/') && parsed.searchParams.get('cluster') === 'devnet' ? parsed.href : undefined; } catch { return undefined; }
}
