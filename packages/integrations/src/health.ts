export type Health = "UP" | "DOWN" | "UNCONFIGURED";
export type HealthProbe = (signal: AbortSignal) => Promise<boolean>;

/** A credential being present is not a successful probe. Register only real service checks. */
export async function health(probes: Record<string, HealthProbe | undefined>) {
  const results = await Promise.all(Object.entries(probes).map(async ([name, probe]) => {
    if (!probe) return [name, "UNCONFIGURED"] as const;
    const signal = AbortSignal.timeout(5000);
    try {
      const passed = await Promise.race([
        probe(signal),
        new Promise<false>(resolve => signal.addEventListener("abort", () => resolve(false), { once: true })),
      ]);
      return [name, passed ? "UP" : "DOWN"] as const;
    } catch { return [name, "DOWN"] as const; }
  }));
  return { app: "UP" as const, ...Object.fromEntries(results) };
}
