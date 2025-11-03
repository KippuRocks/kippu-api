1. Install SDKMAN
2. Use the right java version using `sdk env install` and `sdk env`
3. Start MongoDB using docker-compose: `docker-compose up -d`
4. Create a .env with `MONGO_URL`:
   - For local development (without TLS): `mongodb://user:pass@localhost:27017/kippu?authSource=admin`
   - Note: Remove TLS parameters (`tlsAllowInvalidCertificates`, etc.) when connecting to local MongoDB
5. Set authentication credentials:
   ```bash
   export KIPPU_CLIENT_ID=your_client_id
   export KIPPU_CLIENT_SECRET=your_client_secret
   ```
6. Run the app using `make start`

## Accessing the API

- **Swagger UI**: http://localhost:3000/swagger-ui.html (use `http://` not `https://`)
- **API Base URL**: http://localhost:3000

⚠️ **Important**: The server runs on HTTP only. If you see errors like "Invalid character found in method name", make sure you're using `http://` not `https://` in your browser or API client.

## Authentication

All endpoints require Basic Authentication using your `clientId` and `clientSecret`:
- Format: `Authorization: Basic base64(clientId:clientSecret)`
- In Swagger UI: Click the "Authorize" button and enter your credentials