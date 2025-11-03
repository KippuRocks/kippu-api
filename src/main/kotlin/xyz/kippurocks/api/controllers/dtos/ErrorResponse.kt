package xyz.kippurocks.api.controllers.dtos

import com.fasterxml.jackson.annotation.JsonProperty
import io.swagger.v3.oas.annotations.media.Schema

@Schema(description = "Error response structure")
data class ErrorResponse(
    @Schema(description = "Error message", example = "User not found")
    @JsonProperty("message")
    val message: String,
    @Schema(description = "HTTP status code", example = "404")
    @JsonProperty("status")
    val status: Int,
    @Schema(description = "Timestamp when the error occurred")
    @JsonProperty("timestamp")
    val timestamp: String = java.time.Instant.now().toString()
)

