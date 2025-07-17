package xyz.kippurocks.api.repositories

import org.bson.types.ObjectId
import org.springframework.data.mongodb.repository.MongoRepository
import org.springframework.data.mongodb.repository.Query
import org.springframework.stereotype.Repository
import xyz.kippurocks.api.repositories.entities.UserEntity

@Repository
interface UsersRepository: MongoRepository<UserEntity, ObjectId> {

    @Query("{ \$or: [ { \"username\": ?0 }, { \"contact.accountId\": ?0 } ] }")
    fun findByUsernameOrAccountId(id: String): UserEntity?

}