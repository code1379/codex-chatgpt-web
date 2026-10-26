# Remote ChatGPT Web Gateway (experimental)

This is an experimental standalone Gateway mode built on the `codex-chatgpt-web` Responses bridge. CPA is optional: clients may call this API directly, or CPA may be configured as a downstream aggregator.

## Current status

This is an early implementation branch, not a stable release. It has not yet passed an end-to-end authenticated ChatGPT login or CPA integration test.

Implemented in this branch:
- `bun run src/cli.ts gateway` starts an isolated Gateway entry point.
- The existing Responses core is bound to loopback on port 17841.
- A separate admin/API listener defaults to port 17840.
- Admin login uses `GATEWAY_ADMIN_PASSWORD` and an HttpOnly session cookie.
- Model API requests require `Authorization: Bearer $GATEWAY_API_KEY`.
- Remote login UI controls an isolated Chromium persistent context via screenshots and bounded click/type/keyboard/scroll actions.
- Browser state is sanitized and saved using the existing private file-writing helpers.
- Public listener refuses plain HTTP unless explicitly overridden for an IP-restricted test.
- `GET /healthz`, `GET /v1/models`, and Responses endpoints are proxied through to the loopback core.

## Docker / 1Panel

1. Upload this repository branch to the VPS or clone it there.
2. Copy `.env.gateway.example` to `.env`.
3. Set `GATEWAY_API_KEY` and `GATEWAY_ADMIN_PASSWORD` to unique strong values. Do not reuse CPA management credentials.
4. Put a valid TLS certificate and key in `./certs/fullchain.pem` and `./certs/privkey.pem`, or set `GATEWAY_CERT_DIR`, `GATEWAY_TLS_CERT_FILE`, and `GATEWAY_TLS_KEY_FILE` to your certificate paths.
5. In 1Panel, create a Compose project from `docker-compose.gateway.yml`; use port 17840. Keep internal port 17841 unpublished.
6. Restrict the cloud security-group rule for 17840 to your own public IP if possible. A port allow-rule does not replace HTTPS or authentication.
7. Open `https://YOUR_SERVER_OR_DOMAIN:17840/`, log in with `GATEWAY_ADMIN_PASSWORD`, choose Start browser, sign in to ChatGPT, return to `chatgpt.com`, and click Save session.
8. Call `https://YOUR_SERVER_OR_DOMAIN:17840/v1/models` with `GATEWAY_API_KEY`. Test `POST /v1/responses` before connecting CPA.

## API

- `GET /healthz`: minimal health, no session/account details.
- `GET /v1/models`: API-key protected.
- `POST /v1/responses`: API-key protected, uses the upstream project's existing Responses implementation.
- `POST /v1/responses/compact`, `POST /v1/alpha/search`, and image endpoints are proxied if supported by the core.

Example:

```bash
curl -sS https://YOUR_SERVER_OR_DOMAIN:17840/v1/models \
  -H "Authorization: Bearer $GATEWAY_API_KEY"
```

## Security notes

- This software automates the ChatGPT website unofficially and may be affected by UI changes, account restrictions, and service terms.
- The admin password and API key are different secrets.
- Admin session cookies are in-memory and expire after 12 hours; restarting the container logs out the admin but preserves the browser login state.
- Never publish port 17841. Never expose Chromium DevTools/CDP.
- The first version is experimental: verify login state persistence, model catalog, Responses streaming, cancellation, and CPA Codex-upstream metadata before relying on it.
- No CPA OAuth file is required. A CPA Codex OAuth file is not a ChatGPT browser session and is not imported by this Gateway.
