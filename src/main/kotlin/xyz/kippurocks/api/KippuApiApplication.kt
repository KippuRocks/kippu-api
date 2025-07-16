package xyz.kippurocks.api

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

@SpringBootApplication
class KippuApiApplication

fun main(args: Array<String>) {
	runApplication<KippuApiApplication>(*args)
}
