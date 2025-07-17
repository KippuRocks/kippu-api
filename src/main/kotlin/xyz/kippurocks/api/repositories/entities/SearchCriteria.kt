package xyz.kippurocks.api.repositories.entities

import org.springframework.data.mongodb.core.query.Criteria
import org.springframework.data.mongodb.core.query.Query

data class SearchCriteria (
    var by: String,
) {

    fun toOrQuery(): Query {
        val term = by.takeIf { it.isNotBlank() } ?: return Query()
        val escaped = Regex.escape(term)
        val crits = mutableListOf<Criteria>()

        crits += Criteria.where("username").`is`(term)
        crits += Criteria.where("contact.accountId").`is`(term)
        crits += Criteria.where("contact.email").`is`(term)
        crits += Criteria.where("contact.name")
            .regex("^$escaped\$", "i")

        return Query(Criteria().orOperator(*crits.toTypedArray()))
    }
}