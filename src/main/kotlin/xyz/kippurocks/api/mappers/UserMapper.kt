package xyz.kippurocks.api.mappers

import xyz.kippurocks.api.controllers.dtos.ContactDto
import xyz.kippurocks.api.controllers.dtos.DirectoryUserDto
import xyz.kippurocks.api.controllers.dtos.UserDto
import xyz.kippurocks.api.repositories.entities.ContactEntity
import xyz.kippurocks.api.repositories.entities.CredentialEntity
import xyz.kippurocks.api.repositories.entities.UserEntity

fun UserEntity.toUserDto(): UserDto {
    return UserDto(
        username = this.username,
        contact = ContactDto(
            name = this.contact.name,
            email = this.contact.email,
            accountId = this.contact.accountId
        ),
        credentials = this.credentials.map { it.id.toString() }.toTypedArray()
    )
}

fun UserEntity.toDirectoryUserDto(): DirectoryUserDto {
    return DirectoryUserDto(
        username = this.username,
        contact = ContactDto(
            name = this.contact.name,
            email = this.contact.email,
            accountId = this.contact.accountId
        )
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
        credentials = emptyArray(),
    )
}