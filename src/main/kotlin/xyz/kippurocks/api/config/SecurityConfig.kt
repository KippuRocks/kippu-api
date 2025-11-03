package xyz.kippurocks.api.config

import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.authentication.AuthenticationProvider
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.core.Authentication
import org.springframework.security.core.AuthenticationException
import org.springframework.security.core.authority.AuthorityUtils
import org.springframework.security.web.AuthenticationEntryPoint
import org.springframework.security.web.SecurityFilterChain

@Configuration
@EnableWebSecurity
class SecurityConfig(
    @Value("\${kippu.api.client-id}")
    private val clientId: String,
    @Value("\${kippu.api.client-secret}")
    private val clientSecret: String
) {
    
    @Bean
    fun securityFilterChain(http: HttpSecurity): SecurityFilterChain {
        http
            .csrf { it.disable() }
            .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .authorizeHttpRequests { auth ->
                auth
                    .requestMatchers(
                        "/swagger-ui/**",
                        "/v3/api-docs/**",
                        "/swagger-ui.html",
                        "/error"
                    ).permitAll()
                    .anyRequest().authenticated()
            }
            .httpBasic { httpBasic ->
                httpBasic.authenticationEntryPoint(customAuthenticationEntryPoint())
            }
            .authenticationProvider(clientCredentialsAuthenticationProvider())
            .exceptionHandling { exceptions ->
                exceptions.authenticationEntryPoint(customAuthenticationEntryPoint())
            }
        
        return http.build()
    }
    
    @Bean
    fun clientCredentialsAuthenticationProvider(): AuthenticationProvider {
        return object : AuthenticationProvider {
            override fun authenticate(authentication: Authentication): Authentication {
                // In Basic Auth, Spring Security extracts username:password from the Authorization header
                // and creates an Authentication where:
                // - name = username (clientId in our case)
                // - credentials = password (clientSecret in our case)
                val providedClientId = authentication.name
                val providedClientSecret = authentication.credentials as? String ?: throw BadCredentialsException("Invalid credentials")
                
                // Validate against configured credentials
                if (clientId.isBlank() || clientSecret.isBlank()) {
                    throw BadCredentialsException("Server authentication not configured")
                }
                
                if (providedClientId == clientId && providedClientSecret == clientSecret) {
                    return UsernamePasswordAuthenticationToken(
                        providedClientId,
                        null,
                        AuthorityUtils.createAuthorityList("ROLE_CLIENT")
                    )
                } else {
                    throw BadCredentialsException("Invalid client credentials")
                }
            }
            
            override fun supports(authenticationClass: Class<*>): Boolean {
                return UsernamePasswordAuthenticationToken::class.java.isAssignableFrom(authenticationClass)
            }
        }
    }
    
    private fun customAuthenticationEntryPoint(): AuthenticationEntryPoint {
        return AuthenticationEntryPoint { request: HttpServletRequest,
                                         response: HttpServletResponse,
                                         authException: AuthenticationException ->
            response.status = HttpServletResponse.SC_UNAUTHORIZED
            response.setHeader("WWW-Authenticate", "Basic realm=\"Kippu API\"")
            response.contentType = "application/json"
            
            val errorResponse = """
                {
                    "message": "Authentication required. Please provide valid Basic Authentication credentials.",
                    "status": 401,
                    "timestamp": "${java.time.Instant.now()}"
                }
            """.trimIndent()
            
            response.writer.write(errorResponse)
            response.writer.flush()
        }
    }
}
