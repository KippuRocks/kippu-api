1. Install SDKMAN
2. Use the right java version using `sdk env install` and `sdk env`
3. Start MongoDB using docker-compose: `docker-compose up -d`
4. Create a .env with `MONGO_URL`:
   - For local development (without TLS): `mongodb://user:pass@localhost:27017/kippu?authSource=admin`
   - Note: Remove TLS parameters (`tlsAllowInvalidCertificates`, etc.) when connecting to local MongoDB
5. Run the app using `make start`