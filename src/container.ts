import { Container } from "inversify";
import EventsService from "./services/events.service.js";
import { TYPES } from "./symbols.js";

const container = new Container();
container.bind<EventsService>(TYPES.EventsServiceSymbol).to(EventsService);

export { container };