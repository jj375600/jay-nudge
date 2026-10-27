import pg from "pg";
import { config } from "./config.js";

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: config().DATABASE_URL, max: 10 });
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db().query<T>(text, params);
  return res.rows;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Phone numbers are personal data: logs and the admin view only ever show the last four digits. */
export function maskPhone(phone: string): string {
  return phone.length > 4 ? `${"*".repeat(phone.length - 4)}${phone.slice(-4)}` : "****";
}
