import { FastifyInstance, FastifyRequest } from "fastify"
import EventsService from "../services/events.service.js"
import { container } from "../container.js"
import { TYPES } from "../symbols.js"
import { EventCreateRequestDto } from "./dtos/EventCreateRequest.dto.js"
import { EventUpdateRequestDto } from "./dtos/EventUpdateRequest.dto.js"
import { EventTransferRequestDto } from "./dtos/EventTransferRequest.dto.js"


export default async (fastify: FastifyInstance) => {
    const eventsService = container.get<EventsService>(TYPES.EventsServiceSymbol);

    fastify.post('/', async (request: FastifyRequest, reply) => {
        const {owner, event} = request.body as EventCreateRequestDto;
        return eventsService.createEvent(owner, event)
    })

    fastify.put('/', async (request: FastifyRequest, reply) => {
        const {id, event} = request.body as EventUpdateRequestDto;
        return eventsService.update(id, event)
    })

    fastify.post('/transfer', async (request: FastifyRequest, reply) => {
        const {id, newOwner} = request.body as EventTransferRequestDto;
        return eventsService.transferOwner(id, newOwner)
    })
}