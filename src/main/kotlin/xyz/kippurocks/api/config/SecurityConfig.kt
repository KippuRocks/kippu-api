package xyz.kippurocks.api.config

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.config.Customizer.withDefaults
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity
import org.springframework.security.web.SecurityFilterChain

@Configuration
@EnableWebSecurity
class SecurityConfig {
    @Bean
    fun configure(http: HttpSecurity): SecurityFilterChain {
        http
            .authorizeHttpRequests({ authorize ->
                authorize.anyRequest().permitAll()
            })
            .oauth2Login(withDefaults())
        return http.build()
    }
}