package xyz.kippurocks.api.controllers

import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.annotation.ControllerAdvice
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException
import xyz.kippurocks.api.controllers.dtos.ErrorResponse
import xyz.kippurocks.api.exceptions.UserAlreadyExistsException
import xyz.kippurocks.api.exceptions.UserNotFoundException
import org.springframework.dao.DataAccessException
import org.springframework.dao.DataAccessResourceFailureException
import org.slf4j.LoggerFactory

@ControllerAdvice(basePackages = ["xyz.kippurocks.api.controllers"])
class GlobalExceptionHandler {

    private val logger = LoggerFactory.getLogger(GlobalExceptionHandler::class.java)

    @ExceptionHandler(UserNotFoundException::class)
    fun handleUserNotFound(ex: UserNotFoundException): ResponseEntity<ErrorResponse> {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
            .body(ErrorResponse(
                message = ex.message ?: "User not found",
                status = HttpStatus.NOT_FOUND.value()
            ))
    }

    @ExceptionHandler(UserAlreadyExistsException::class)
    fun handleUserAlreadyExists(ex: UserAlreadyExistsException): ResponseEntity<ErrorResponse> {
        return ResponseEntity.status(HttpStatus.CONFLICT)
            .body(ErrorResponse(
                message = ex.message ?: "User already exists",
                status = HttpStatus.CONFLICT.value()
            ))
    }

    @ExceptionHandler(IllegalArgumentException::class)
    fun handleIllegalArgument(ex: IllegalArgumentException): ResponseEntity<ErrorResponse> {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ErrorResponse(
                message = ex.message ?: "Invalid argument",
                status = HttpStatus.BAD_REQUEST.value()
            ))
    }

    @ExceptionHandler(HttpMessageNotReadableException::class)
    fun handleHttpMessageNotReadable(ex: HttpMessageNotReadableException): ResponseEntity<ErrorResponse> {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ErrorResponse(
                message = "Invalid request body: ${ex.message}",
                status = HttpStatus.BAD_REQUEST.value()
            ))
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException::class)
    fun handleMethodArgumentTypeMismatch(ex: MethodArgumentTypeMismatchException): ResponseEntity<ErrorResponse> {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ErrorResponse(
                message = "Invalid parameter type for '${ex.name}': ${ex.message}",
                status = HttpStatus.BAD_REQUEST.value()
            ))
    }

    @ExceptionHandler(MethodArgumentNotValidException::class)
    fun handleMethodArgumentNotValid(ex: MethodArgumentNotValidException): ResponseEntity<ErrorResponse> {
        val errors = ex.bindingResult.fieldErrors.joinToString(", ") { 
            "${it.field}: ${it.defaultMessage}" 
        }
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ErrorResponse(
                message = "Validation failed: $errors",
                status = HttpStatus.BAD_REQUEST.value()
            ))
    }

    @ExceptionHandler(DataAccessResourceFailureException::class)
    fun handleDataAccessResourceFailure(ex: DataAccessResourceFailureException): ResponseEntity<ErrorResponse> {
        logger.error("Database connection failed", ex)
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
            .body(ErrorResponse(
                message = "Cannot connect to database. Please check your connection settings.",
                status = HttpStatus.SERVICE_UNAVAILABLE.value()
            ))
    }

    @ExceptionHandler(DataAccessException::class)
    fun handleDataAccessException(ex: DataAccessException): ResponseEntity<ErrorResponse> {
        logger.error("Database error occurred", ex)
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(ErrorResponse(
                message = "Database error occurred. Please try again later.",
                status = HttpStatus.INTERNAL_SERVER_ERROR.value()
            ))
    }

    @ExceptionHandler(Exception::class)
    fun handleGenericException(ex: Exception): ResponseEntity<ErrorResponse> {
        logger.error("Unexpected error occurred", ex)
        
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(ErrorResponse(
                message = "An unexpected error occurred. Please try again later.",
                status = HttpStatus.INTERNAL_SERVER_ERROR.value()
            ))
    }
}

