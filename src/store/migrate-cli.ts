import { loadConfig } from "../config.js";
import { migrate } from "./migrate.js";
import { createStore } from "./store.js";

const config = loadConfig();
const store = createStore(config.databaseUrl);
try {
  const applied = await migrate(store);
  console.log(applied.length === 0 ? "the store is up to date" : `applied: ${applied.join(", ")}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await store.end();
}
