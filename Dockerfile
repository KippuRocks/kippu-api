# syntax=docker/dockerfile:1
FROM eclipse-temurin:17-jdk AS build

WORKDIR /workspace
COPY gradlew gradlew
COPY gradle gradle
COPY build.gradle.kts settings.gradle.kts ./
COPY src src
RUN ./gradlew --no-daemon bootJar -x test


FROM eclipse-temurin:17-jre

RUN addgroup --system app && adduser --system --ingroup app app
WORKDIR /app
COPY --from=build /workspace/build/libs/*.jar app.jar
USER app
EXPOSE 8080

ENTRYPOINT ["java", "-jar", "app.jar"]
