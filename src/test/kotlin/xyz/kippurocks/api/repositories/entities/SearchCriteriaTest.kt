package xyz.kippurocks.api.repositories.entities

import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.TestComponent
import java.net.URLEncoder
import kotlin.test.assertEquals

@TestComponent
class SearchCriteriaTest {

    @Test
    fun `Should build the right url with all fields`() {
        val name = "John Doe"
        val username = "john.doe"
        val email = "j.doe@gmail.com"
        val accountId = "LK4JN3KHKJB34N"
        val searchCriteria = SearchCriteria(
            name,
            username,
            email,
            accountId
        )
        assertEquals(
            URLEncoder.encode("name:\"$name\" AND username:\"$username\" AND email:\"$email\" AND accountId:\"$accountId\"", "UTF-8"),
            searchCriteria.getQuery()
        )
    }


    @Test
    fun `Should build the right url with partial fields`() {
        val username = "john.doe"
        val accountId = "LK4JN3KHKJB34N"
        val searchCriteria = SearchCriteria(
            null,
            username,
            "",
            accountId
        )
        assertEquals(
            URLEncoder.encode("username:\"$username\" AND accountId:\"$accountId\"", "UTF-8"),
            searchCriteria.getQuery()
        )
    }

}