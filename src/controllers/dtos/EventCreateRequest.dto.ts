import { AccountId, Event } from "@ticketto/types"

export interface EventCreateRequestDto {
    owner: AccountId;
    event: Omit<Event, "id">;
}