export type IntegrationResult<T> =
  | { status: "OK"; provider: string; value: T }
  | { status: "UNAVAILABLE" | "FAILED"; provider: string; code: string };

export class IntegrationError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Do not propagate provider response bodies: they may echo private prompts or secrets. */
export async function attempt<T>(provider: string, configured: boolean, run: () => Promise<T>): Promise<IntegrationResult<T>> {
  if (!configured) return { status: "UNAVAILABLE", provider, code: "NOT_CONFIGURED" };
  try { return { status: "OK", provider, value: await run() }; }
  catch (error) {
    return { status: "FAILED", provider, code: error instanceof IntegrationError ? error.code : "PROVIDER_ERROR" };
  }
}

export type Fetch = typeof globalThis.fetch;

export async function requestJson(fetcher: Fetch, url: string, init: RequestInit, timeoutMs = 20_000): Promise<unknown> {
  const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new IntegrationError(`HTTP_${response.status}`);
  return response.json();
}
