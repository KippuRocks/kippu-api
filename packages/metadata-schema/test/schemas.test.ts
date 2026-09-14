import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  CLASS_SCHEMA_ID,
  classSchema,
  EVENT_SCHEMA_ID,
  eventSchema,
  SCHEMA_BASE_URL,
  schemas,
} from "../src/index.js";

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function validator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats.default(ajv);
  for (const schema of schemas) {
    ajv.addSchema(schema);
  }
  return ajv;
}

describe("metadata schemas", () => {
  it("REQ-MD-4: every schema is JSON Schema 2020-12 with a versioned $id under meta.kippu.rocks", () => {
    for (const schema of schemas) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.$id.startsWith(SCHEMA_BASE_URL)).toBe(true);
      expect(schema.$id).toMatch(/\/\d+\.\d+\.json$/);
    }
    expect(eventSchema.$id).toBe(EVENT_SCHEMA_ID);
    expect(classSchema.$id).toBe(CLASS_SCHEMA_ID);
  });

  it("REQ-MD-4: every schema compiles under a strict 2020-12 validator", () => {
    const ajv = validator();
    for (const schema of schemas) {
      expect(ajv.getSchema(schema.$id)).toBeTypeOf("function");
    }
  });

  it("REQ-MD-4: the schema files served by path are the schemas the package exports", async () => {
    const files = [
      ["../schemas/event/1.0.json", eventSchema],
      ["../schemas/class/1.0.json", classSchema],
    ] as const;
    for (const [path, schema] of files) {
      const onDisk = JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
      expect(onDisk).toEqual(schema);
    }
  });

  describe.each([
    { document: "event.json", schemaId: EVENT_SCHEMA_ID },
    { document: "class.json", schemaId: CLASS_SCHEMA_ID },
  ])("$document", ({ document, schemaId }) => {
    const validate = (value: unknown): boolean => {
      const check = validator().getSchema(schemaId);
      if (check === undefined) {
        throw new Error(`schema ${schemaId} is not registered`);
      }
      return check(value) as boolean;
    };

    it("REQ-MD-4: validates against the schema it declares", async () => {
      const value = await fixture(document);
      expect(value.$schema).toBe(schemaId);
      expect(validate(value)).toBe(true);
    });

    it("REQ-MD-4: is refused without a declared schema version", async () => {
      const { $schema: _, ...undeclared } = await fixture(document);
      expect(validate(undeclared)).toBe(false);
    });

    it("REQ-MD-4: is refused when it declares another schema version", async () => {
      const value = await fixture(document);
      expect(validate({ ...value, $schema: schemaId.replace("/1.0.json", "/2.0.json") })).toBe(
        false,
      );
    });

    it("NFR-6: is refused when it carries a field the schema does not declare", async () => {
      const value = await fixture(document);
      expect(validate({ ...value, email: "someone@example.invalid" })).toBe(false);
    });
  });

  it("refuses an event document whose image is not served over HTTPS", async () => {
    const value = await fixture("event.json");
    const check = validator().getSchema(EVENT_SCHEMA_ID);
    expect(check?.({ ...value, imagery: [{ url: "http://example.invalid/a.jpg" }] })).toBe(false);
  });

  it("refuses an organiser described by anything but a trading name", async () => {
    const value = await fixture("event.json");
    const check = validator().getSchema(EVENT_SCHEMA_ID);
    expect(check?.({ ...value, organiser: { tradingName: "Sala Norte", firstName: "Ana" } })).toBe(
      false,
    );
  });
});
