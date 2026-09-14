/**
 * `pnpm sponsor:start` — the sponsor relay, as its own process (`F-023` plan
 * §5.1). It neither starts nor needs kippu-api's server.
 */
import { kmsP256Signer } from "@kippu/sponsorship";
import { softwareKmsP256Key } from "@kippu/sponsorship/testing";
import { loadSponsorRelayConfig } from "./config.js";
import { connectRelayDerivedCopy } from "./derived.js";
import { createEntitlements } from "./entitlements.js";
import { buildSponsorRelay } from "./relay.js";

const config = loadSponsorRelayConfig();
// No KMS provider is chosen: the configuration refuses production, and a
// software key stands in for the sponsor's KMS key elsewhere. A provider's
// adapter implements `KmsP256Key` and replaces it here.
const sponsor = kmsP256Signer(softwareKmsP256Key({ secretKey: config.softwareSecretKey }));
const derived = connectRelayDerivedCopy(config.derivedDatabaseUrl);
const entitlements = createEntitlements({
  derived: derived.queries,
  registrationRateLimit: config.registrationRateLimit,
});
const app = buildSponsorRelay({ sponsor, derived, entitlements }, { logger: true });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await derived.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ sponsor: sponsor.account }, "sponsoring as this account");
} catch (error) {
  app.log.error(error);
  await derived.close();
  process.exit(1);
}
