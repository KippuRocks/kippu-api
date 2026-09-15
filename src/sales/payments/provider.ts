import { bloquePaymentsClient, createBloquePaymentProvider } from "./bloque.js";
import type { PaymentsConfig } from "./config.js";
import type { PaymentProvider } from "./ports.js";
import { createTestPaymentProvider } from "./test-provider.js";

/** The payment provider a configuration names (`T-022-01`). */
export function paymentProviderFor(config: PaymentsConfig): PaymentProvider {
  switch (config.provider) {
    case "test":
      return createTestPaymentProvider();
    case "bloque":
      return createBloquePaymentProvider({
        client: bloquePaymentsClient(config.bloque),
        webhookSecret: config.bloque.webhookSecret,
      });
  }
}
