import { Event } from "@ticketto/types"

export interface EventTransferRequestDto {
    id: number;
    newOwner: Omit<Event, "id">;
}