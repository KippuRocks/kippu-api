/**
 * `pnpm reviewer:create --email <email>`, `pnpm reviewer:reissue-code --email <email>`,
 * `pnpm reviewer:disable --email <email>` — the only way reviewer accounts are
 * made and unmade (`T-021-16`; `F-021` plan §5.4): by someone with deployment
 * access, against the Kippu store, never over HTTP.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createStore } from "../store/store.js";
import { createReviewers } from "./service.js";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { email: { type: "string" } } });

if (!["create", "reissue-code", "disable"].includes(command ?? "") || values.email === undefined) {
  console.error("usage: reviewer <create | reissue-code | disable> --email <email>");
  process.exit(2);
}

const config = loadConfig();
const store = createStore(config.databaseUrl);
const reviewers = createReviewers({ store, relyingParty: config.login });
try {
  if (command === "disable") {
    const { reviewer, sessionsEnded } = await reviewers.disable(values.email);
    console.log(`disabled reviewer ${reviewer.email}; ended ${sessionsEnded} session(s)`);
  } else {
    const created =
      command === "create"
        ? await reviewers.create(values.email)
        : await reviewers.reissueCode(values.email);
    console.log(`reviewer ${created.reviewer.email}`);
    console.log(`enrolment code: ${created.code}`);
    console.log(`expires: ${created.codeExpiresAt}`);
    console.log("share the code with the reviewer over a trusted channel; it is shown once");
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await store.end();
}
