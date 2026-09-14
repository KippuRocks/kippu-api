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
});

export type AppRouter = typeof appRouter;
