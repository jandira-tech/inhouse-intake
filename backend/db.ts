import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import type { IntakeRecord } from "../shared/types.ts";

// Bump the suffix when changing schema (Val Town SQLite has limited ALTER support).
// v2: requester_department is now nullable — Department was always meant to be
// Optional in the IntakeRecord type, but v1 declared it NOT NULL and broke when
// users genuinely skipped the field after the ISSUE-006 fix went live.
const TABLE = "intakes_v2";

let migrated = false;

export async function migrate(): Promise<void> {
  if (migrated) return;
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      requester_name TEXT NOT NULL,
      requester_email TEXT NOT NULL,
      requester_department TEXT,
      matter_type TEXT NOT NULL,
      short_title TEXT NOT NULL,
      urgency TEXT NOT NULL,
      payload TEXT NOT NULL
    )
  `);
  migrated = true;
}

export async function saveIntake(intake: IntakeRecord): Promise<number> {
  await migrate();
  const result = await sqlite.execute({
    sql: `INSERT INTO ${TABLE}
      (requester_name, requester_email, requester_department, matter_type, short_title, urgency, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      intake.requester_name,
      intake.requester_email,
      intake.requester_department,
      intake.matter_type,
      intake.short_title,
      intake.urgency,
      JSON.stringify(intake),
    ],
  });
  // libsql returns lastInsertRowid as bigint
  return Number(result.lastInsertRowid ?? 0);
}

export interface IntakeRow {
  id: number;
  created_at: string;
  requester_name: string;
  requester_email: string;
  /** Nullable since v2 — Department was always semantically optional. */
  requester_department: string | null;
  matter_type: string;
  short_title: string;
  urgency: string;
  payload: IntakeRecord;
}

/** SQLite null preserved as JSON null. Without this, `String(null)` returns
 *  the literal four-character string "null" — a bug surfaced post-v2 schema. */
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export async function listIntakes(limit = 50): Promise<IntakeRow[]> {
  await migrate();
  const result = await sqlite.execute({
    sql: `SELECT id, created_at, requester_name, requester_email, requester_department,
                 matter_type, short_title, urgency, payload
          FROM ${TABLE}
          ORDER BY id DESC
          LIMIT ?`,
    args: [limit],
  });
  return result.rows.map(r => ({
    id: Number(r[0]),
    created_at: String(r[1]),
    requester_name: String(r[2]),
    requester_email: String(r[3]),
    requester_department: strOrNull(r[4]),
    matter_type: String(r[5]),
    short_title: String(r[6]),
    urgency: String(r[7]),
    payload: JSON.parse(String(r[8])),
  }));
}
