package xyz.kippurocks.api.controllers.dtos

import com.fasterxml.jackson.annotation.JsonProperty
import io.swagger.v3.oas.annotations.media.Schema

@Schema(description = "Credential creation request")
data class CredentialDto (
    @Schema(description = "Credential value (will be stored securely)", example = "credential_value_here")
    @JsonProperty("credential")
    var credential: String
)

@Schema(description = "Credential creation response")
data class CredentialResponseDto (
    @Schema(description = "Unique identifier of the created credential", example = "507f1f77bcf86cd799439011")
    @JsonProperty("id")
    val id: String
)