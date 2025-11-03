package xyz.kippurocks.api.services

import org.springframework.data.mongodb.core.MongoTemplate
import org.springframework.data.mongodb.core.query.Criteria
import org.springframework.data.mongodb.core.query.Query
import org.springframework.data.mongodb.core.query.Update
import org.springframework.stereotype.Service
import xyz.kippurocks.api.controllers.dtos.ContactDto
import xyz.kippurocks.api.controllers.dtos.CredentialDto
import xyz.kippurocks.api.controllers.dtos.CredentialResponseDto
import xyz.kippurocks.api.controllers.dtos.DirectoryUserDto
import xyz.kippurocks.api.controllers.dtos.UserDto
import xyz.kippurocks.api.mappers.toDirectoryUserDto
import xyz.kippurocks.api.mappers.toEntity
import xyz.kippurocks.api.mappers.toUserDto
import xyz.kippurocks.api.repositories.UsersRepository
import xyz.kippurocks.api.repositories.entities.CredentialEntity
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
    
    fun getUserEntity(username: String): UserEntity? {
        return usersRepository.findByUsernameOrAccountId(username)
    }

    fun getUsersBy(criteria: SearchCriteria): List<UserDto> {
        return mongoTemplate.find(criteria.toOrQuery(), UserEntity::class.java).map { it.toUserDto() }
    }
    
    fun getDirectoryUsersBy(criteria: SearchCriteria): List<xyz.kippurocks.api.controllers.dtos.DirectoryUserDto> {
        return mongoTemplate.find(criteria.toOrQuery(), UserEntity::class.java).map { it.toDirectoryUserDto() }
    }

    fun createUser(user: UserDto): UserDto {
        user.credentials = emptyArray()
        val savedUser = usersRepository.save(user.toEntity())
        return savedUser.toUserDto()
    }

    fun updateUser(username: String, updates: ContactDto): UserDto {
        val query = Query(
            Criteria.where("username").`is`(username)
        )
        val update = Update()
        if (!updates.name.isNullOrBlank()) update.set("contact.name", updates.name)
        if (!updates.email.isNullOrBlank()) update.set("contact.email", updates.email)
        mongoTemplate.updateFirst(query, update, UserEntity::class.java)
        
        // Fetch and return updated user
        val updatedUser = usersRepository.findByUsernameOrAccountId(username)
            ?: throw xyz.kippurocks.api.exceptions.UserNotFoundException("User not found with username: $username")
        return updatedUser.toUserDto()
    }

    fun addCredential(username: String, currentCredentials: Array<CredentialEntity>, newCredential: CredentialDto): CredentialResponseDto {
        val query = Query(
            Criteria.where("username").`is`(username)
        )
        val newCredentialEntity = CredentialEntity(value = newCredential.credential)
        val newCredentials = currentCredentials.toMutableList()
        newCredentials.add(newCredentialEntity)
        
        val update = Update()
        update.set("credentials", newCredentials)
        mongoTemplate.updateFirst(query, update, UserEntity::class.java)
        
        return CredentialResponseDto(id = newCredentialEntity.id.toString())
    }

    fun removeCredential(username: String, currentCredentials: Array<CredentialEntity>, credentialId: String): Unit {
        val query = Query(
            Criteria.where("username").`is`(username)
        )
        val newCredentials = currentCredentials.filterNot { it.id.toString() == credentialId }.toMutableList()
        
        val update = Update()
        update.set("credentials", newCredentials)
        mongoTemplate.updateFirst(query, update, UserEntity::class.java)
    }
}