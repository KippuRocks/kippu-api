import { randomUUID } from "node:crypto";
import type { RelayRequest } from "../../src/audit/audit-log.js";
import type { Store } from "../../src/store/store.js";

/**
 * A test-only organiser account, written straight to the store: sign-up
 * belongs to `T-020-05`, and these tests need only the row. Returns the
 * organiser's id and a request made in a session of theirs.
 */
export async function createOrganiser(
  store: Store,
): Promise<{ organiserId: string; request: RelayRequest }> {
  const organiserId = randomUUID();
  await store.query("INSERT INTO organisers (id, email) VALUES ($1, $2)", [
    organiserId,
    `organiser-${organiserId}@kippu.example`,
  ]);
  return {
    organiserId,
    request: {
      requestId: `req-${randomUUID()}`,
      principal: { kind: "organiser", organiserId, sessionId: randomUUID() },
    },
  };
}
