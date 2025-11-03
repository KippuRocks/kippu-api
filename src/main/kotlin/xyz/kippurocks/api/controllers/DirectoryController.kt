package xyz.kippurocks.api.controllers

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import io.swagger.v3.oas.annotations.media.Content
import io.swagger.v3.oas.annotations.media.Schema
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.tags.Tag
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import xyz.kippurocks.api.controllers.dtos.DirectoryUserDto
import xyz.kippurocks.api.repositories.entities.SearchCriteria
import xyz.kippurocks.api.services.UsersService

@RestController
@RequestMapping("/contacts")
@Tag(name = "Directory", description = "Directory/contact search endpoints (credentials excluded for security)")
class DirectoryController(
    private val usersService: UsersService
) {
    @GetMapping
    @Operation(
        summary = "Search contacts",
        description = "Searches for contacts by criteria. Note: Credentials are never returned in directory responses for security reasons."
    )
    @ApiResponse(
        responseCode = "200",
        description = "List of contacts matching the search criteria (credentials excluded)",
        content = [Content(schema = Schema(implementation = Array<DirectoryUserDto>::class))]
    )
    fun getContactsBy(
        @Parameter(description = "Search criteria", example = "john")
        @RequestParam by: String
    ): List<DirectoryUserDto> {
        return if (by.isEmpty()) emptyList()
        else usersService.getDirectoryUsersBy(SearchCriteria(by))
    }
}