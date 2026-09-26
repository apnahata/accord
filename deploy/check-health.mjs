// Readiness gate: optional services cannot make Mongo/application safety permissive.
try {
  const response = await fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(3000), redirect: "error" });
  const health = await response.json();
  if (!response.ok || health.app !== "UP" || health.mongo !== "UP") process.exitCode = 1;
} catch { process.exitCode = 1; }
