import { AccountId, EventId } from "@ticketto/types";
import { EventsModule, TickettoClient } from "@ticketto/protocol";
import { Event } from "@ticketto/types"
import { injectable, inject } from "inversify";
import { TYPES } from "../symbols.js";

@injectable()
export default class EventsService {
    private readonly events: EventsModule;
    constructor (
        @inject(TYPES.TickettoClientSymbol) 
        public readonly client: TickettoClient,
    ) {
        this.events = client.events;
    }

    async getEvent(id: EventId): Promise<Event> {
        return await this.events.query.get(id) ?? Promise.reject("Event not found");
    }

    createEvent(owner: AccountId, event: Omit<Event, "id">): Promise<number> {
        return this.events.calls.createEvent(owner, event);
    }

    update(id: number, event: Partial<Omit<Event, "id">>): Promise<void> {
        return this.events.calls.update(id, event);
    }

    transferOwner(id: number, newOwner: Omit<Event, "id">): Promise<void> {
        return this.events.calls.transferOwner(id, newOwner);
    }

}