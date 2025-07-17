package xyz.kippurocks.api

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication
import org.springframework.data.mongodb.repository.config.EnableMongoRepositories

@SpringBootApplication
@EnableMongoRepositories("xyz.kippurocks.api.repositories")
class KippuApiApplication

fun main(args: Array<String>) {
	runApplication<KippuApiApplication>(*args)
}
