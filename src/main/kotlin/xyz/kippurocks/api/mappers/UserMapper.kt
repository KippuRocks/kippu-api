package xyz.kippurocks.api.mappers

import xyz.kippurocks.api.controllers.dtos.ContactDto
import xyz.kippurocks.api.controllers.dtos.UserDto
import xyz.kippurocks.api.repositories.entities.ContactEntity
import xyz.kippurocks.api.repositories.entities.UserEntity

fun UserEntity.toUserDto(): UserDto {
    return UserDto(
        username = this.username,
        contact = ContactDto(
            name = this.contact.name,
            email = this.contact.email,
            accountId = this.contact.accountId
        ),
        credentials = this.credentials
    )
}

fun UserDto.toEntity(): UserEntity {
    return UserEntity(
        username = this.username,
        contact = ContactEntity(
            name = this.contact.name,
            email = this.contact.email,
            accountId = this.contact.accountId
        ),
        credentials = this.credentials,
    )
}