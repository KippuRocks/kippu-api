include .env
export

start:
	./gradlew clean bootRun

deploy:
	sh ./scripts/deploy.sh $(github-owner) $(image-name) $(tag)