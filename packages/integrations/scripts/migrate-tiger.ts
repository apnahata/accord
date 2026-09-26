import { readdir, readFile } from "node:fs/promises";
import { createTigerPool } from "../src/tiger.js";

if (!process.env.TIGER_DATABASE_URL) throw new Error("TIGER_DATABASE_URL is required; migration was not run");
const pool = createTigerPool(process.env.TIGER_DATABASE_URL);
try {
  const dir = new URL("../sql/", import.meta.url);
  // Every migration is idempotent; run them all in order.
  for (const file of (await readdir(dir)).filter(name => name.endsWith(".sql")).sort()) {
    await pool.query(await readFile(new URL(file, dir), "utf8"));
    console.log(`Applied ${file}`);
  }
  console.log("Tiger migrations completed");
} finally { await pool.end(); }
