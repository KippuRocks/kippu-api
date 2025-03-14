import { Event } from "@ticketto/types";

export interface EventUpdateRequestDto {
  id: number;
  event: Partial<Omit<Event, "id">>;
}
