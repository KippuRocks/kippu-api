import { randomBytes, randomUUID } from "node:crypto";
import { hashSecret } from "../../src/auth/service.js";
import type { Store } from "../../src/store/store.js";

/**
 * A test-only issuer of operator enrolment codes with an expiry of the test's
 * choosing, written straight to the store, for `T-020-05`'s redemption tests.
 * Organisers issue codes through `operators.issueEnrolmentCode` (`T-024-01`).
 */
export async function issueEnrolmentCode(
  store: Store,
  { organiserId, expiresAt }: { organiserId: string; expiresAt: Date },
): Promise<{ operatorId: string; code: string }> {
  const operatorId = randomUUID();
  const code = randomBytes(16).toString("base64url");
  await store.query("INSERT INTO operators (id, organiser_id, name) VALUES ($1, $2, $3)", [
    operatorId,
    organiserId,
    "Test operator",
  ]);
  await store.query(
    "INSERT INTO operator_enrolment_codes (code_hash, operator_id, expires_at) VALUES ($1, $2, $3)",
    [hashSecret(code), operatorId, expiresAt],
  );
  return { operatorId, code };
}
