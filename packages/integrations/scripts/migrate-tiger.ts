import { readFile } from "node:fs/promises";
import { createTigerPool } from "../src/tiger.js";

if (!process.env.TIGER_DATABASE_URL) throw new Error("TIGER_DATABASE_URL is required; migration was not run");
const pool = createTigerPool(process.env.TIGER_DATABASE_URL);
try {
  await pool.query(await readFile(new URL("../sql/001_events.sql", import.meta.url), "utf8"));
  console.log("Tiger event migration completed");
} finally { await pool.end(); }
