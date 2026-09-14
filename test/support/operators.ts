import { randomBytes, randomUUID } from "node:crypto";
import { hashSecret } from "../../src/auth/service.js";
import type { Store } from "../../src/store/store.js";

/**
 * A test-only issuer of operator enrolment codes. Issuing codes, and the
 * operator accounts they enrol, belong to `F-024`; `T-020-05` builds only the
 * redemption. Nothing under `src/` issues a code.
 */
export async function issueEnrolmentCode(
  store: Store,
  { organiserId, expiresAt }: { organiserId: string; expiresAt: Date },
): Promise<{ operatorId: string; code: string }> {
  const operatorId = randomUUID();
  const code = randomBytes(16).toString("base64url");
  await store.query("INSERT INTO operators (id, organiser_id) VALUES ($1, $2)", [
    operatorId,
    organiserId,
  ]);
  await store.query(
    "INSERT INTO operator_enrolment_codes (code_hash, operator_id, expires_at) VALUES ($1, $2, $3)",
    [hashSecret(code), operatorId, expiresAt],
  );
  return { operatorId, code };
}
