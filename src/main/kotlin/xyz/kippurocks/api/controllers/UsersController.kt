package xyz.kippurocks.api.controllers

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import io.swagger.v3.oas.annotations.media.Content
import io.swagger.v3.oas.annotations.media.Schema
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.security.SecurityRequirement
import io.swagger.v3.oas.annotations.tags.Tag
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import xyz.kippurocks.api.controllers.dtos.ContactDto
import xyz.kippurocks.api.controllers.dtos.CredentialDto
import xyz.kippurocks.api.controllers.dtos.CredentialResponseDto
import xyz.kippurocks.api.controllers.dtos.ErrorResponse
import xyz.kippurocks.api.controllers.dtos.UserDto
import xyz.kippurocks.api.exceptions.UserAlreadyExistsException
import xyz.kippurocks.api.exceptions.UserNotFoundException
import xyz.kippurocks.api.services.UsersService

@RestController
@RequestMapping("/users")
@Tag(name = "Users", description = "User management endpoints")
@SecurityRequirement(name = "basicAuth")
class UsersController(
    private val usersService: UsersService
) {
    @GetMapping("/{id}")
    @Operation(summary = "Get user by ID", description = "Retrieves a user by username or account ID")
    @ApiResponses(
        value = [
            ApiResponse(responseCode = "200", description = "User found", content = [Content(schema = Schema(implementation = UserDto::class))]),
            ApiResponse(responseCode = "404", description = "User not found", content = [Content(schema = Schema(implementation = ErrorResponse::class))])
        ]
    )
    fun getUser(
        @Parameter(description = "Username or account ID", example = "johndoe")
        @PathVariable id: String
    ): UserDto {
        val user = usersService.getUser(id)
            ?: throw UserNotFoundException("User not found with id: $id")
        return user
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Create a new user", description = "Creates a new user with the provided information")
    @ApiResponses(
        value = [
            ApiResponse(responseCode = "201", description = "User created successfully", content = [Content(schema = Schema(implementation = UserDto::class))]),
            ApiResponse(responseCode = "409", description = "User already exists", content = [Content(schema = Schema(implementation = ErrorResponse::class))]),
            ApiResponse(responseCode = "400", description = "Invalid input", content = [Content(schema = Schema(implementation = ErrorResponse::class))])
        ]
    )
    fun createUser(
        @RequestBody user: UserDto
    ): UserDto {
        val existingUser = usersService.getUser(user.username)
        if (existingUser != null) {
            throw UserAlreadyExistsException("The user with username '${user.username}' already exists")
        }
        return usersService.createUser(user)
    }

    @PutMapping("/{username}")
    @Operation(summary = "Update user contact information", description = "Updates the contact information for an existing user")
    @ApiResponses(
        value = [
            ApiResponse(responseCode = "200", description = "User updated successfully", content = [Content(schema = Schema(implementation = UserDto::class))]),
            ApiResponse(responseCode = "404", description = "User not found", content = [Content(schema = Schema(implementation = ErrorResponse::class))]),
            ApiResponse(responseCode = "400", description = "Invalid input", content = [Content(schema = Schema(implementation = ErrorResponse::class))])
        ]
    )
    fun updateUser(
        @Parameter(description = "Username", example = "johndoe")
        @PathVariable username: String,
        @RequestBody updates: ContactDto
    ): UserDto {
        val existingUser = usersService.getUser(username)
            ?: throw UserNotFoundException("User not found with username: $username")
        return usersService.updateUser(username, updates)
    }

    @PostMapping("/{username}/credentials")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Add credential to user", description = "Adds a new credential to an existing user and returns the credential ID")
    @ApiResponses(
        value = [
            ApiResponse(responseCode = "201", description = "Credential added successfully", content = [Content(schema = Schema(implementation = CredentialResponseDto::class))]),
            ApiResponse(responseCode = "404", description = "User not found", content = [Content(schema = Schema(implementation = ErrorResponse::class))]),
            ApiResponse(responseCode = "400", description = "Invalid input", content = [Content(schema = Schema(implementation = ErrorResponse::class))])
        ]
    )
    fun addCredential(
        @Parameter(description = "Username", example = "johndoe")
        @PathVariable username: String,
        @RequestBody credential: CredentialDto
    ): CredentialResponseDto {
        val existingUserEntity = usersService.getUserEntity(username)
            ?: throw UserNotFoundException("User not found with username: $username")
        return usersService.addCredential(username, existingUserEntity.credentials, credential)
    }

    @DeleteMapping("/{username}/credentials/{credential}")
    @Operation(summary = "Remove credential from user", description = "Removes a credential from a user by credential ID")
    @ApiResponses(
        value = [
            ApiResponse(responseCode = "204", description = "Credential removed successfully"),
            ApiResponse(responseCode = "404", description = "User not found", content = [Content(schema = Schema(implementation = ErrorResponse::class))])
        ]
    )
    fun removeCredential(
        @Parameter(description = "Username", example = "johndoe")
        @PathVariable username: String,
        @Parameter(description = "Credential ID", example = "507f1f77bcf86cd799439011")
        @PathVariable credential: String
    ): ResponseEntity<Void> {
        val existingUserEntity = usersService.getUserEntity(username)
            ?: throw UserNotFoundException("User not found with username: $username")
        usersService.removeCredential(username, existingUserEntity.credentials, credential)
        return ResponseEntity.noContent().build()
    }
}