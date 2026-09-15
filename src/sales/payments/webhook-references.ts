import type { VerifiedWebhook } from "./ports.js";

/** The metadata key a hosted checkout carries its hold's id under. */
export const HOLD_METADATA_KEY = "kippu_hold";

/** Keys a provider payload may name a checkout under, at the top level or one object deep. */
const CHECKOUT_KEYS = ["url_id", "urn", "id", "payment_urn", "checkout_id"] as const;

/** Objects a provider payload may nest its checkout in. */
const NESTED_KEYS = ["payment", "checkout", "data"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * What a verified webhook payload names: checkout identifiers and hold ids.
 *
 * `@bloque/payments` 0.2.1 types no webhook payload, so the payload is read
 * loosely, and only for hints: nothing named here is trusted until the checkout
 * is retrieved from the provider (`F-022` plan §5.4). A payload naming nothing
 * yields empty lists.
 */
export function webhookReferences(payload: unknown): VerifiedWebhook {
  const checkoutIds = new Set<string>();
  const holdIds = new Set<string>();
  const visit = (value: Record<string, unknown>) => {
    for (const key of CHECKOUT_KEYS) {
      const id = value[key];
      if (typeof id === "string" && id !== "") checkoutIds.add(id);
    }
    const hold = record(value.metadata)?.[HOLD_METADATA_KEY];
    if (typeof hold === "string" && hold !== "") holdIds.add(hold);
  };
  const top = record(payload);
  if (top !== null) {
    visit(top);
    for (const key of NESTED_KEYS) {
      const nested = record(top[key]);
      if (nested !== null) visit(nested);
    }
  }
  return { checkoutIds: [...checkoutIds], holdIds: [...holdIds] };
}
