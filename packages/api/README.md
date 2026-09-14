# @kippu/api

The Kippu API's tRPC router type — contract `C5`. Types only: no server
implementation ships in this package.

```ts
import type { AppRouter } from "@kippu/api";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

const kippu = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "https://<kippu-api host>/v0/trpc" })],
});

await kippu.system.health.query();
```

A failed call carries the `SPEC.md` §10 code, when there is one, verbatim in
`error.data.errorCode` — for example `ERR-EventNotFound`.

Depend on it by version. A breaking change to the router type is a major
version (`F-020` plan, §5.2). `@trpc/server` is a peer dependency: the
declarations refer to its types.
