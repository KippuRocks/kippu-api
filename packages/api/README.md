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

### Signing in

Organisers sign in with an explicit WebAuthn exchange on Kippu's login RP id:

```ts
const challenge = await kippu.auth.organiser.beginSignIn.mutate({ email });
const credential = await startAuthentication({ optionsJSON: challenge.options }); // e.g. @simplewebauthn/browser
const { session } = await kippu.auth.organiser.completeSignIn.mutate({
  ceremonyId: challenge.ceremonyId,
  credential,
});
// Send `Authorization: Bearer ${session.token}` until `session.expiresAt`.
```

Sign-up is the same shape: `beginSignUp`, then `completeSignUp`. Operators
redeem the one-time code their organiser issued with
`auth.operator.redeemEnrolmentCode`. `auth.session.current` names the
principal, and `auth.session.signOut` ends the session.

A failed call carries the `SPEC.md` §10 code, when there is one, verbatim in
`error.data.errorCode` — for example `ERR-EventNotFound`.

Depend on it by version. A breaking change to the router type is a major
version (`F-020` plan, §5.2). `@trpc/server` is a peer dependency: the
declarations refer to its types.
