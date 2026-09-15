import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { EventId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import type { Classes } from "../classes/classes.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import { ownedEvent } from "./ownership.js";
import type {
  CreatedInvitation,
  CreateInvitationInput,
  EventsRequest,
  Invitation,
  InvitationStatus,
  IssuedTicket,
  IssueGrantedInput,
  ListInvitationsInput,
  PlacementInput,
  RedeemedInvitation,
  RedeemInvitationInput,
} from "./ports.js";
import { normaliseDesignation, type Zones } from "./zones.js";

/** Bytes of randomness in an invitation token. */
export const INVITATION_TOKEN_BYTES = 32;

export interface Invitations {
  create(
    organiserId: string,
    request: EventsRequest,
    input: CreateInvitationInput,
  ): Promise<CreatedInvitation>;
  list(organiserId: string, input: ListInvitationsInput): Promise<readonly Invitation[]>;
  redeem(
    holder: string,
    request: EventsRequest,
    input: RedeemInvitationInput,
  ): Promise<RedeemedInvitation>;
}

export interface InvitationsOptions {
  readonly store: Store;
  readonly authority: Pick<OrganiserAuthority, "account">;
  readonly ledger: Pick<KippuTicketto, "getEvent">;
  readonly classes: Pick<Classes, "find">;
  readonly zones: Pick<Zones, "canonicalPosition">;
  /** Granted issuance (`T-021-05`), which a redemption runs for the invitation's organiser. */
  readonly issueGranted: (
    organiserId: string,
    request: EventsRequest,
    input: IssueGrantedInput,
  ) => Promise<IssuedTicket>;
  readonly now?: () => Date;
}

interface InvitationRow {
  readonly id: string;
  readonly event: string;
  readonly class_id: string;
  readonly zone: string;
  readonly placement_kind: "Seated" | "Unseated";
  readonly position: string | null;
  readonly guest: string | null;
  readonly organiser_id: string;
  readonly status: InvitationStatus;
  readonly holder: string | null;
  readonly ticket: string | null;
  readonly created_at: Date;
  readonly redeemed_at: Date | null;
}

const COLUMNS = `id, event, class_id, zone, placement_kind, position, guest, organiser_id, status,
  holder, ticket, created_at, redeemed_at`;

const hashToken = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

function placementOf(row: InvitationRow): PlacementInput {
  return row.placement_kind === "Seated"
    ? { kind: "Seated", position: row.position as string }
    : { kind: "Unseated" };
}

function invitationOf(row: InvitationRow): Invitation {
  return {
    id: row.id,
    event: row.event,
    class: row.class_id,
    zone: row.zone,
    placement: placementOf(row),
    guest: row.guest,
    status: row.status,
    holder: row.holder,
    ticket: row.ticket,
    createdAt: row.created_at.toISOString(),
    redeemedAt: row.redeemed_at === null ? null : row.redeemed_at.toISOString(),
  };
}

/**
 * Invitations (`T-021-12`; `F-021` plan §5.6). A guest without a holder account
 * cannot be issued a ticket yet (`US-D2` is beyond V0): the organiser creates an
 * invitation, its link opens Saifu, which links the guest's holder account and
 * redeems the token, and the class's ticket is issued to that account.
 *
 * - **Creation** checks what issuance will: the organiser owns the event, the
 *   class is a `Granted` class of it, and a seat is a canonical position of a
 *   seated zone the event defines. The token — 32 random bytes — is returned
 *   once; Kippu keeps only its SHA-256.
 * - **Redemption** claims the invitation atomically, so it issues at most once
 *   however many redemptions race, then runs granted issuance (`T-021-05`) for
 *   the invitation's organiser, on behalf of the holder's request: quota,
 *   capacity and every ledger rule apply, and the write is audited against the
 *   holder's session (`NFR-7`). A refused issuance reopens the invitation; one
 *   with no ledger verdict leaves it `failed`, since the ticket may exist.
 * - An unknown token is refused as `NOT_FOUND`; one already redeemed, or being
 *   redeemed, as `CONFLICT`.
 */
export function createInvitations(options: InvitationsOptions): Invitations {
  const {
    store,
    authority,
    ledger,
    classes,
    zones,
    issueGranted,
    now = () => new Date(),
  } = options;

  return {
    async create(organiserId, request, input) {
      const { event } = await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      const ticketClass = await classes.find(input.event, input.class);
      if (ticketClass === null) {
        throw new SpecCodeError("ERR-UnknownClass", "the class is not defined for the event");
      }
      if (ticketClass.provenance !== "Granted") {
        throw new RefusedRequest("an invitation is to a Granted class");
      }
      const zone = event.zones.find(({ id }) => id === input.zone);
      if (zone === undefined) {
        throw new SpecCodeError(
          "ERR-UnknownZone",
          `zone ${input.zone} is not defined for the event`,
        );
      }
      if (zone.kind !== input.placement.kind) {
        throw new SpecCodeError(
          "ERR-ZoneKindMismatch",
          `a ${input.placement.kind} placement in a ${zone.kind} zone`,
        );
      }
      if (input.placement.kind === "Seated") {
        await zones.canonicalPosition(input.event, input.zone, input.placement.position);
      }

      const token = randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");
      const inserted = await store.query<InvitationRow>(
        `INSERT INTO invitations
           (id, token_hash, event, class_id, zone, placement_kind, position, guest, organiser_id,
            created_request_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${COLUMNS}`,
        [
          randomUUID(),
          hashToken(token),
          input.event,
          input.class,
          input.zone,
          input.placement.kind,
          input.placement.kind === "Seated" ? normaliseDesignation(input.placement.position) : null,
          input.guest,
          organiserId,
          request.requestId,
          now(),
        ],
      );
      return { invitation: invitationOf(inserted.rows[0] as InvitationRow), token };
    },

    async list(organiserId, input) {
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      const rows = await store.query<InvitationRow>(
        `SELECT ${COLUMNS} FROM invitations
         WHERE event = $1 AND ($2::text IS NULL OR class_id = $2)
         ORDER BY created_at, id`,
        [input.event, input.class],
      );
      return rows.rows.map(invitationOf);
    },

    async redeem(holder, request, input) {
      const tokenHash = hashToken(input.token);
      const claimed = await store.query<InvitationRow>(
        `UPDATE invitations SET status = 'redeeming', holder = $2
         WHERE token_hash = $1 AND status = 'open'
         RETURNING ${COLUMNS}`,
        [tokenHash, holder],
      );
      const row = claimed.rows[0];
      if (row === undefined) {
        const found = await store.query("SELECT 1 FROM invitations WHERE token_hash = $1", [
          tokenHash,
        ]);
        if ((found.rowCount ?? 0) === 0) {
          throw new RefusedRequest("no invitation has this token", "NOT_FOUND");
        }
        throw new RefusedRequest("the invitation has already been redeemed", "CONFLICT");
      }

      let issued: IssuedTicket;
      try {
        issued = await issueGranted(row.organiser_id, request, {
          event: row.event,
          class: row.class_id,
          zone: row.zone,
          placement: placementOf(row),
          holder,
        });
      } catch (error) {
        // A refusal — Kippu's or the ledger's — issued nothing: the invitation reopens.
        // Anything else may have issued the ticket, so the invitation stays spent.
        const refused = error instanceof SpecCodeError || error instanceof RefusedRequest;
        await store.query(
          refused
            ? "UPDATE invitations SET status = 'open', holder = NULL WHERE id = $1"
            : "UPDATE invitations SET status = 'failed' WHERE id = $1",
          [row.id],
        );
        throw error;
      }
      await store.query(
        `UPDATE invitations SET status = 'redeemed', ticket = $2, redeemed_at = $3
         WHERE id = $1`,
        [row.id, issued.ticket, now()],
      );
      return { ...issued, event: row.event, class: row.class_id };
    },
  };
}
