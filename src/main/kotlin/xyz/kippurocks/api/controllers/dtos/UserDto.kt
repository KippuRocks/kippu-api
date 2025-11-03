package xyz.kippurocks.api.controllers.dtos

import com.fasterxml.jackson.annotation.JsonProperty
import io.swagger.v3.oas.annotations.media.Schema

@Schema(description = "User information")
data class UserDto (
    @Schema(description = "Unique username", example = "johndoe")
    @JsonProperty("username")
    var username: String,
    @Schema(description = "Contact information")
    @JsonProperty("contact")
    var contact: ContactDto,
    @Schema(description = "Array of credential IDs (credentials are never exposed, only IDs)", example = "[\"507f1f77bcf86cd799439011\", \"507f191e810c19729de860ea\"]")
    @JsonProperty("credentials")
    var credentials: Array<String>, // Array of credential IDs
)

@Schema(description = "User information for directory listing (credentials excluded for security)")
data class DirectoryUserDto (
    @Schema(description = "Unique username", example = "johndoe")
    @JsonProperty("username")
    var username: String,
    @Schema(description = "Contact information")
    @JsonProperty("contact")
    var contact: ContactDto,
    // No credentials field - excluded for security
)

@Schema(description = "Contact information")
data class ContactDto (
    @Schema(description = "Contact name", example = "John Doe", required = false)
    @JsonProperty("name")
    var name: String?,
    @Schema(description = "Email address", example = "john.doe@example.com", required = false)
    @JsonProperty("email")
    var email: String?,
    @Schema(description = "Account identifier", example = "ACC123456")
    @JsonProperty("accountId")
    var accountId: String,
)