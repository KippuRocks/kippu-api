package xyz.kippurocks.api.services

import org.springframework.data.mongodb.core.MongoTemplate
import org.springframework.data.mongodb.core.query.Criteria
import org.springframework.data.mongodb.core.query.Query
import org.springframework.data.mongodb.core.query.Update
import org.springframework.stereotype.Service
import xyz.kippurocks.api.controllers.dtos.ContactDto
import xyz.kippurocks.api.controllers.dtos.CredentialDto
import xyz.kippurocks.api.controllers.dtos.UserDto
import xyz.kippurocks.api.mappers.toEntity
import xyz.kippurocks.api.mappers.toUserDto
import xyz.kippurocks.api.repositories.UsersRepository
import xyz.kippurocks.api.repositories.entities.SearchCriteria
import xyz.kippurocks.api.repositories.entities.UserEntity

@Service
class UsersService(
    private val usersRepository: UsersRepository,
    private val mongoTemplate: MongoTemplate
) {
    fun getUser(id: String): UserDto? {
        val user = usersRepository.findByUsernameOrAccountId(id)
        return user?.toUserDto()
    }

    fun getUsersBy(criteria: SearchCriteria): List<UserDto> {
        return mongoTemplate.find(criteria.toOrQuery(), UserEntity::class.java).map { it.toUserDto() }
    }

    fun createUser(user: UserDto): String {
        user.credentials = emptyArray()
        return usersRepository.save(user.toEntity()).id.toString()
    }

    fun updateUser(username: String, updates: ContactDto): Unit {
        val query = Query(
            Criteria.where("username").`is`(username)
        )
        val update = Update()
        if (!updates.name.isNullOrBlank()) update.set("contact.name", updates.name)
        if (!updates.email.isNullOrBlank()) update.set("contact.email", updates.email)
        mongoTemplate.updateFirst(query, update, UserEntity::class.java)
    }

    fun addCredential(username: String, currentCredentials: Array<String>, newCredential: CredentialDto) {
        val query = Query(
            Criteria.where("username").`is`(username)
        )
        val update = Update()
        val newCredentials = currentCredentials.toMutableList()
        newCredentials.add(newCredential.credential)
        update.set("credentials", newCredentials)
        mongoTemplate.updateFirst(query, update, UserEntity::class.java)
    }

    fun removeCredential(username: String, currentCredentials: Array<String>, credential: String) {
        val query = Query(
            Criteria.where("username").`is`(username)
        )
        val update = Update()
        val newCredentials = currentCredentials.toMutableList()
        newCredentials.remove(credential)
        update.set("credentials", newCredentials)
        mongoTemplate.updateFirst(query, update, UserEntity::class.java)
    }
}