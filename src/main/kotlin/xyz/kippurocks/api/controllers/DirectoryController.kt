package xyz.kippurocks.api.controllers

import org.springframework.stereotype.Controller
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseBody
import xyz.kippurocks.api.controllers.dtos.UserDto
import xyz.kippurocks.api.repositories.entities.SearchCriteria
import xyz.kippurocks.api.services.UsersService


@Controller
@RequestMapping("/contacts")
class DirectoryController(
    private val usersService: UsersService
) {
    @GetMapping
    @ResponseBody
    fun getContactsBy(@RequestParam by: String): List<UserDto> {
        return if (by.isEmpty()) return emptyList()
        else usersService.getUsersBy(SearchCriteria(by))
    }
}