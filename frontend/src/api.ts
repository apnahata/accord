export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
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
  MEMBERS_NOT_READY: 'Not everyone has confirmed their requirements yet. Accord can search once every member is ready.',
  NO_FEASIBLE_OFFER: 'No current stay meets every confirmed requirement.',
  ROOM_FULL: 'This group is already full.',
  NOT_READY_TO_BOOK: 'Every member must approve and authorize their share before booking.',
  OWN_CONSTRAINT_FAILED: 'This proposal doesn’t meet one of your own requirements, so it can’t be approved from your account.',
  CONSTRAINTS_REQUIRED: 'Confirm your requirements in your private space first.',
  OFFER_VERSION_MISMATCH: 'This offer changed since you loaded it. Refresh to see the latest version.',
  MERCHANT_BOOKING_FAILED: 'The demo merchant couldn’t complete the booking. No payment or booking success has been confirmed.',
  PERSISTENCE_UNAVAILABLE: 'Accord couldn’t save this change. Please try again. No success has been confirmed.',
  MEMBER_ALREADY_READY: 'This member has already confirmed their requirements, so they can’t be removed.',
  CANNOT_REMOVE_HOST: 'The host can’t be removed from the group.',
  MEMBER_NOT_FOUND: 'This member is no longer in the group.',
  ADMIN_ACCESS_DENIED: 'Only the group host can do that.',
  PROPOSAL_STALE: 'Something changed since this was approved: the price, the terms, or the group. Previous approvals can’t be used. Review the latest state.',
  STAY_SEARCH_UNAVAILABLE: 'Live stay search isn’t configured on this server.',
  STAY_SEARCH_FAILED: 'The live stay providers didn’t respond. Please try again in a moment.',
  BOOKING_PROVIDER_UNAVAILABLE: 'The booking provider couldn’t be reached, so nothing was booked. Please try again.',
  HOST_CANNOT_LEAVE: 'The host can’t leave the group.',
  ALREADY_BOOKED: 'This group has already booked.',
  TRIP_IN_PAST: 'Choose trip dates in the future.',
  AI_UNAVAILABLE:'The assistant is unavailable right now. You can still enter your requirements with the form.',
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
    throw new ApiError(response.status, code, codeCopy[code] || errorCopy[response.status] ||'Accord couldn’t complete this request. No payment or booking success has been confirmed.');
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
export const date = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }).format(new Date(value));
export const dateTime = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }).format(new Date(value));
export function safeExplorer(url?: string) {
  if (!url) return undefined;
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'explorer.solana.com' && parsed.pathname.startsWith('/tx/') && parsed.searchParams.get('cluster') === 'devnet' ? parsed.href : undefined; } catch { return undefined; }
}
