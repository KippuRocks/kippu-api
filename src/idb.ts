import type { ShimmedObject } from "indexeddbshim/dist/setGlobalVars.js";
import setGlobalVars from "indexeddbshim";

setGlobalVars(globalThis as unknown as ShimmedObject, {
  checkOrigin: false,
  memoryDatabase: process.env.DB ?? ":memory:",
});
