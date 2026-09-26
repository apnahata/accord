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
    throw new ApiError(response.status, typeof body.code === 'string' ? body.code : 'REQUEST_FAILED', errorCopy[response.status] || 'Accord couldn’t complete this request. No payment or booking success has been confirmed.');
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
