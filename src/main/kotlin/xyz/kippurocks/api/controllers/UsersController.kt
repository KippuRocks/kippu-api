package xyz.kippurocks.api.controllers

import org.springframework.data.crossstore.ChangeSetPersister.NotFoundException
import org.springframework.stereotype.Controller
import org.springframework.web.bind.annotation.*
import xyz.kippurocks.api.controllers.dtos.ContactDto
import xyz.kippurocks.api.controllers.dtos.CredentialDto
import xyz.kippurocks.api.controllers.dtos.UserDto
import xyz.kippurocks.api.services.UsersService

@Controller
@RequestMapping("/users")
class UsersController(
    private val usersService: UsersService
) {
    @GetMapping("/{id}")
    @ResponseBody
    fun getUser(
        @PathVariable id: String
    ): UserDto? {
        val user = usersService.getUser(id)
        require(user != null) {"User not Found"}
        return user
    }

    @PostMapping
    @ResponseBody
    fun createUser(
        @RequestBody user: UserDto
    ): String {
        val existingUser = usersService.getUser(user.username)
        require(existingUser == null) {"The user with that username already exists"}
        return usersService.createUser(user)
    }

    @PutMapping("/{username}")
    @ResponseBody
    fun updateUser(
        @PathVariable username: String,
        @RequestBody updates: ContactDto
    ) {
        val existingUser = usersService.getUser(username)
        require(existingUser != null) {"User not Found"}
        usersService.updateUser(username, updates)
    }

    @PostMapping("/{username}/credentials")
    @ResponseBody
    fun addCredential(
        @PathVariable username: String,
        @RequestBody credential: CredentialDto
    ) {
        val existingUser = usersService.getUser(username)
        require(existingUser != null) {"User not Found"}
        usersService.addCredential(username, existingUser.credentials, credential)
    }

    @DeleteMapping("/{username}/credentials/{credential}")
    @ResponseBody
    fun removeCredential(
        @PathVariable username: String,
        @PathVariable credential: String
    ) {
        val existingUser = usersService.getUser(username)
        require(existingUser != null) {"User not Found"}
        usersService.removeCredential(username, existingUser.credentials, credential)
    }
}