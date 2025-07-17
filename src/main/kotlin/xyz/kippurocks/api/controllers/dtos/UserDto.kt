package xyz.kippurocks.api.controllers.dtos

import kotlinx.serialization.Serializable

@Serializable
data class UserDto (
    var username: String,
    var contact: ContactDto,
    var credentials: Array<String>,
)

@Serializable
data class ContactDto (
    var name: String?,
    var email: String?,
    var accountId: String,
)