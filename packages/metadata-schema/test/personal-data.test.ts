import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isDeniedFieldName, lintPersonalData, schemas } from "../src/index.js";

describe("personal-data field lint", () => {
  it("NFR-6: no published schema declares a personal-data field", () => {
    for (const schema of schemas) {
      expect(lintPersonalData(schema)).toEqual([]);
    }
  });

  it("NFR-6: a deny-listed field fails the lint", async () => {
    const schema: unknown = JSON.parse(
      await readFile(new URL("./fixtures/personal-data.schema.json", import.meta.url), "utf8"),
    );

    expect(lintPersonalData(schema)).toEqual([
      { pointer: "/properties/contactEmail", field: "contactEmail" },
      { pointer: "/properties/organiser/properties/full_name", field: "full_name" },
      { pointer: "/required/1", field: "contactEmail" },
    ]);
  });

  it("NFR-6: finds deny-listed fields at any depth and in every keyword that names a field", () => {
    const schema = {
      $defs: { person: { properties: { dateOfBirth: {} } } },
      items: { properties: { phoneNumber: {} } },
      anyOf: [{ required: ["passport"] }],
      additionalProperties: { properties: { surname: {} } },
      dependentRequired: { name: ["holderName"] },
      dependentSchemas: { nationalId: {} },
    };

    expect(lintPersonalData(schema).map(({ field }) => field)).toEqual([
      "holderName",
      "nationalId",
      "phoneNumber",
      "surname",
      "passport",
      "dateOfBirth",
    ]);
  });

  it("NFR-6: normalises case and separators", () => {
    for (const field of ["email", "Email", "e_mail", "E-Mail", "first_name", "FirstName"]) {
      expect(isDeniedFieldName(field)).toBe(true);
    }
  });

  it("allows the fields public documents need", () => {
    for (const field of ["name", "tradingName", "className", "description", "streetAddress"]) {
      expect(isDeniedFieldName(field)).toBe(false);
    }
  });
});
