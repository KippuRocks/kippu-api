import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import { toTRPCError } from "../trpc/errors.js";
import { organiserProcedure, router } from "../trpc/trpc.js";
import type { PutClassDocumentInput, PutEventDocumentInput, WrittenDocument } from "./ports.js";

/**
 * Validates with a schema, and types the input as `T` — a type declared without
 * imports, so the published router type never refers to the validator.
 */
function parser<T>(schema: z.ZodType): (value: unknown) => T {
  return (value) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new TRPCError({ code: "BAD_REQUEST", message: z.prettifyError(result.error) });
    }
    return result.data as T;
  };
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SpecCodeError) {
      throw toTRPCError(error);
    }
    if (error instanceof RefusedRequest) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    throw error;
  }
}

const id32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lower-case hex characters");

/** The document's shape is its JSON Schema's to check (`F-026` plan §5.2); here, only that it is a JSON object. */
const document = z.record(z.string(), z.json());

const putEventDocumentInput = z.object({ event: id32, document }).strict();

const putClassDocumentInput = z.object({ event: id32, class: id32, document }).strict();

/**
 * Organisers' editing of public metadata documents (`US-A3`, `F-026` plan §5.4).
 * Each mutation validates the whole document against the schema it declares and
 * writes it at its locator; none writes to the ledger (`AC-A3.1`). A document
 * that does not conform is refused as `BAD_REQUEST`; an event the organiser does
 * not own with `ERR-NotOwner`, and a class the event does not have with
 * `ERR-UnknownClass`.
 */
export const metadataRouter = router({
  events: router({
    /** Writes an event's document, replacing the previous version, at the locator the ledger holds. */
    put: organiserProcedure
      .input(parser<PutEventDocumentInput>(putEventDocumentInput))
      .mutation(
        ({ ctx, input }): Promise<WrittenDocument> =>
          mapped(() => ctx.services.metadata.putEventDocument(ctx.principal.organiserId, input)),
      ),
  }),
  classes: router({
    /** Writes a ticket class's document, replacing the previous version, at its derived locator. */
    put: organiserProcedure
      .input(parser<PutClassDocumentInput>(putClassDocumentInput))
      .mutation(
        ({ ctx, input }): Promise<WrittenDocument> =>
          mapped(() => ctx.services.metadata.putClassDocument(ctx.principal.organiserId, input)),
      ),
  }),
});
