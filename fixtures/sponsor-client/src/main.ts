// `node src/main.ts <relay URL>`: creates a p256 credential, signs the
// registerCredential command that creates its account — sponsored always
// (F-023 plan §5.3) — and obtains a sponsorship for it over plain HTTP.

import { randomBytes } from "node:crypto";
import { createProfileV0 } from "@ticketto/profile-v0";
import { softwareP256Signer } from "@ticketto/profile-v0/testing";
import type { Command, OperationId, Timestamp } from "@ticketto/sdk";
import { requestSponsorship } from "./relay-client.ts";

const relayUrl = process.argv[2];
if (relayUrl === undefined) {
  console.error("usage: node src/main.ts <relay URL>");
  process.exit(2);
}

const profile = createProfileV0({ rpId: "holder.kippu.example" });
const credential = softwareP256Signer();
const command: Command = {
  kind: "registerCredential",
  operationId: randomBytes(16).toString("hex") as OperationId,
  expiresAt: (Date.now() + 60_000) as Timestamp,
  account: credential.signer.account,
  registration: credential.registration,
};
const authorisation = await credential.signer.sign(profile.encodeCommand(command));
const result = await requestSponsorship(relayUrl, { command, authorisation });

if (result.status !== "sponsored") {
  console.error(`no sponsorship: ${result.status} ${result.detail ?? ""}`);
  process.exit(1);
}
console.log(
  `sponsored registerCredential for ${command.account}: ${result.sponsorship.length} bytes`,
);
