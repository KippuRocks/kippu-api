package xyz.kippurocks.api.repositories.entities

import org.bson.types.ObjectId

data class CredentialEntity(
    val id: ObjectId = ObjectId.get(),
    val value: String
)

