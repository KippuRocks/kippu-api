# @kippurocks/metadata-schema

JSON Schemas (2020-12) for Kippu's public metadata documents — contract `C6`.

| Document | Locator | Schema |
|---|---|---|
| Event | `https://meta.kippu.rocks/v0/events/<EventId>.json` | `https://meta.kippu.rocks/v0/schemas/event/1.0.json` |
| Ticket class | `https://meta.kippu.rocks/v0/classes/<ClassId>.json` | `https://meta.kippu.rocks/v0/schemas/class/1.0.json` |

Documents are public, and anyone can read them without a Kippu account (`REQ-MD-4`). Every
document declares the versioned schema it conforms to in `$schema`. A minor
version only adds optional fields. A breaking change is a new major version,
served side by side. Schemas are closed: a field a schema does not declare is
refused.

```ts
import { EVENT_SCHEMA_ID, eventSchema, classSchema } from "@kippurocks/metadata-schema";
import eventSchemaFile from "@kippurocks/metadata-schema/event/1.0.json" with { type: "json" };
```

## No personal data

Documents are public by requirement, so no schema declares a personal-data
field. An organiser who is a natural person is described by a trading name
(`organiser.tradingName`), never by a personal one. The deny-list lint enforces
this for every schema:

```sh
pnpm build
pnpm lint:personal-data   # fails, naming the field, if a schema declares a deny-listed one
```

`lintPersonalData(schema)` exposes the same check as a function.
