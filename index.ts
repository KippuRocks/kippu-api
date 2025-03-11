import fastify from 'fastify'
import eventRoutes from './src/controllers/events.controller.js'
import './src/container'
import { container } from './src/container.js'
import { TYPES } from './src/symbols.js'
import { TickettoClientBuilder } from "@ticketto/protocol";
import { TickettoWebStubConsumer } from '@ticketto/web-stub'

const server = fastify()

const tickettoClient = await (new TickettoClientBuilder()
    .withConsumer(TickettoWebStubConsumer))
    .withConfig({
        accountProvider: {
          getAccountId: () => {
            return "An Id xd"
          },
          sign: (payload: Uint8Array) => Promise.resolve(payload),
        },
      })
    .build()

container.bind(TYPES.TickettoClientSymbol)
    .toConstantValue(tickettoClient)

server.register(eventRoutes, {prefix: "/events"})

server.listen({ port: 8080 }, (err, address) => {
    if (err) {
        console.error(err)
        process.exit(1)
    }
    console.log(`Server listening at ${address}`)
})
