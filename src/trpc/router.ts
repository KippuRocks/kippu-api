import { authRouter } from "../auth/router.js";
import { derivedRouter } from "../derived/router.js";
import { eventsRouter } from "../events/router.js";
import { metadataRouter } from "../metadata/router.js";
import { operatorsRouter } from "../operators/router.js";
import { reviewersRouter } from "../reviewers/router.js";
import { salesRouter } from "../sales/router.js";
import { publicProcedure, router } from "./trpc.js";

/**
 * Kippu's own procedures, which belong to no domain feature.
 */
const systemRouter = router({
  health: publicProcedure.query(() => ({ status: "ok" }) as const),
});

/**
 * The root router: the `C5` contract. Domain routers (`F-021`–`F-026`) are
 * composed in here, one per feature.
 */
export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  events: eventsRouter,
  metadata: metadataRouter,
  derived: derivedRouter,
  sales: salesRouter,
  operators: operatorsRouter,
  reviewers: reviewersRouter,
});

export type AppRouter = typeof appRouter;
