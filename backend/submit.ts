import { assertIntakeRecord } from "../shared/catalog.ts";
import type { IntakeRecord, SubmitResponse } from "../shared/types.ts";

export function persistenceEnabled(token: string | undefined): boolean {
  return Boolean(token?.trim());
}

export class InvalidIntakeError extends Error {}

/** Validate regardless of mode; persist only when an administrator can retrieve records. */
export async function submitIntake(
  intake: unknown,
  token: string | undefined,
  save: (value: IntakeRecord) => Promise<number>,
): Promise<SubmitResponse> {
  try { assertIntakeRecord(intake); } catch { throw new InvalidIntakeError("Invalid intake record"); }
  for (const key of ["requester_name", "requester_email", "matter_type", "short_title", "description", "urgency"] as const) {
    if (!intake[key].trim()) throw new InvalidIntakeError(`${key} is required`);
  }
  if (intake.conflict_check_acknowledged !== true || intake.confidentiality_acknowledged !== true) {
    throw new InvalidIntakeError("Both acknowledgements are required");
  }
  if (!persistenceEnabled(token)) return { ok: true, intake_id: 0, demo: true };
  return { ok: true, intake_id: await save(intake) };
}
