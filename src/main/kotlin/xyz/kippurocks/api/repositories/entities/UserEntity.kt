package xyz.kippurocks.api.repositories.entities

import org.bson.types.ObjectId
import org.springframework.data.annotation.Id
import org.springframework.data.mongodb.core.mapping.Document

@Document(collection = "users")
data class UserEntity (
    @Id
    val id: ObjectId? = null,
    val username: String,
    val contact: ContactEntity,
    val credentials: Array<CredentialEntity>,
)

data class ContactEntity(
    val name: String? = null,
    val email: String? = null,
    val accountId: String,
)