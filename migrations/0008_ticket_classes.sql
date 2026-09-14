-- Ticket classes (T-021-04; US-B2, REQ-TC-1–REQ-TC-3).
--
-- A class is Kippu data and never reaches the ledger (REQ-TC-2): its name,
-- description and quota live here. What reaches the ledger, per ticket, is the
-- class's opaque identifier and the provenance, attendance policy and
-- restrictions it determines. An event may have any number of classes, each
-- configured independently (REQ-TC-1).

CREATE TABLE ticket_classes (
  -- The opaque ClassId tickets carry: 32 random bytes, lower-case hex.
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  -- The ledger's EventId. The ledger records who owns the event (REQ-IX-1).
  event text NOT NULL CHECK (event ~ '^[0-9a-f]{64}$'),
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text CHECK (length(description) <= 5000),
  provenance text NOT NULL CHECK (provenance IN ('Purchased', 'Granted')),
  -- The attendance policy, in the SDK's shape: {"kind": "Single"}, and so on.
  policy jsonb NOT NULL CHECK (policy ->> 'kind' IN ('Single', 'Multiple', 'Unlimited')),
  cannot_resale boolean NOT NULL,
  cannot_transfer boolean NOT NULL,
  -- NULL: no class quota. The event's capacity still bounds issuance (REQ-TC-5).
  quota bigint CHECK (quota >= 0),
  created_request_id text NOT NULL,
  created_at timestamptz NOT NULL,
  -- REQ-TC-3: a class declared Purchased declares no restriction.
  CONSTRAINT ticket_classes_purchased_unrestricted
    CHECK (provenance = 'Granted' OR NOT (cannot_resale OR cannot_transfer)),
  -- REQ-TK-2: cannot_transfer implies cannot_resale.
  CONSTRAINT ticket_classes_transfer_implies_resale CHECK (cannot_resale OR NOT cannot_transfer)
);

CREATE INDEX ticket_classes_event ON ticket_classes (event, created_at);
