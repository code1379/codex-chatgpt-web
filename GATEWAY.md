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

1. The Gateway image is built by GitHub Actions and published to `ghcr.io/code1379/codex-chatgpt-web-gateway:gateway-latest`. Set the GitHub Container Registry package visibility to **Public** after the first successful publish so 1Panel can pull it without a registry login. The VPS does not need to clone source code or build the image.
2. Download `docker-compose.gateway.yml` and `.env.gateway.example` from the `feat/remote-gateway` branch into the same 1Panel Compose project directory. Copy `.env.gateway.example` to `.env`.
3. Set `GATEWAY_API_KEY` and `GATEWAY_ADMIN_PASSWORD` to unique strong values. Do not reuse CPA management credentials.
4. Put a valid TLS certificate and key in `./certs/fullchain.pem` and `./certs/privkey.pem`, or set `GATEWAY_CERT_DIR`, `GATEWAY_TLS_CERT_FILE`, and `GATEWAY_TLS_KEY_FILE` to your certificate paths.
5. In 1Panel, create a Compose project from `docker-compose.gateway.yml`. By default, port 17840 is published on `127.0.0.1` only; port 17841 is never published.
6. For a temporary test, keep the public port closed and use an SSH tunnel or a 1Panel reverse proxy with HTTPS. If you choose to publish 17840 directly, first configure TLS certificates, set `GATEWAY_BIND_IP=0.0.0.0`, configure valid TLS certificate/key paths, set `GATEWAY_ALLOW_INSECURE_HTTP=false`, and verify the HTTPS endpoint. Restrict the cloud security-group rule to your own public IP. Do not expose plain HTTP with admin/browser controls.
7. Open the secured URL, log in with `GATEWAY_ADMIN_PASSWORD`, choose Start browser, sign in to ChatGPT, return to `chatgpt.com`, and click Save session.
8. Call `/v1/models` with `GATEWAY_API_KEY`. Test `POST /v1/responses` before connecting CPA.

## API

- `GET /healthz`: minimal health, no session/account details.
- `GET /v1/models`: API-key protected.
- `POST /v1/responses`: API-key protected, uses the upstream project's existing Responses implementation.
- `POST /v1/responses/compact` is proxied to the existing core. Search and image endpoints are not exposed by this Gateway allowlist in the current prototype.

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


## Direct 1Panel Compose deployment (no `.env` file)

Use [`docker-compose.gateway.1panel.yml`](https://github.com/code1379/codex-chatgpt-web/blob/feat/remote-gateway/docker-compose.gateway.1panel.yml) when creating the project directly in 1Panel. This file uses the prebuilt GHCR image and puts environment variables inline, so you do not need to clone the repository or upload `.env.gateway.example`.

1. In 1Panel, open **Containers → Compose/Orchestration** and create a new project.
2. Choose the editor / custom Compose option and paste the complete contents of `docker-compose.gateway.1panel.yml`.
3. Before deploying, replace `GATEWAY_API_KEY` and `GATEWAY_ADMIN_PASSWORD` with unique random secrets. API key should be at least 32 characters; admin password at least 16 characters. Do not leave any `REPLACE_WITH_...` value.
4. Keep `GATEWAY_HOST: 127.0.0.1` and `network_mode: host`. Do not expose ports 17840 or 17841 in the cloud security group.
5. Deploy the project. The service uses a named Docker volume `gateway-data` to persist browser login state.
6. Add the 1Panel Website for `gateway.ohmygod.qzz.io`, enable a valid HTTPS certificate, and reverse proxy to `http://127.0.0.1:17840`. Preserve the Host header and send `X-Forwarded-Proto: https`.
7. Open `https://gateway.ohmygod.qzz.io/`, sign in to the Gateway admin panel, start the browser, log in to ChatGPT, and save the session.

Note: the Gateway image must have been published successfully by GitHub Actions and the GHCR package must be Public before 1Panel can pull it without registry credentials. The project remains experimental until real ChatGPT login and Responses API tests pass.

### 1Panel domain + HTTPS reverse proxy (recommended)

The Compose project uses Docker host networking and binds the Gateway listener directly to VPS loopback `127.0.0.1:17840`; the internal Responses core binds to `127.0.0.1:17841`. Neither port is exposed on the public interface. The Compose file enables trusted-proxy handling for the 1Panel/OpenResty HTTPS terminator.

1. Add a DNS A record for `gateway.ohmygod.qzz.io` pointing to your VPS. Cloudflare orange-cloud DNS-over-HTTPS should return Cloudflare edge IPs; a local `dig` result in `198.18.0.0/15` can be a proxy Fake-IP.
2. Create the Compose project using the image-based `docker-compose.gateway.yml` and set strong unique values in `.env`. Do not open TCP/17840 or TCP/17841 in the cloud security group. With host networking, both listeners bind only to VPS loopback.
3. In 1Panel, create a Website for the subdomain and enable HTTPS with a valid certificate.
4. Set the website's reverse proxy target to `http://127.0.0.1:17840`. Preserve the original Host header and pass `X-Forwarded-Proto: https`.
5. Visit `https://your-subdomain/`. Log in with `GATEWAY_ADMIN_PASSWORD`, start the browser, complete ChatGPT sign-in, then save the session.
6. Verify `https://gateway.ohmygod.qzz.io/healthz`, then call `GET /v1/models` using `GATEWAY_API_KEY`. Do not connect CPA until these pass.
7. For updates, use 1Panel to pull/recreate the container using the same Compose file. The `pull_policy: always` setting makes Compose check the published `gateway-latest` image. For a reproducible rollback, change the image tag to a specific `sha-<commit>` tag.

Do not use `GATEWAY_ALLOW_INSECURE_HTTP=true` with a publicly bound port. With this recommended topology, the public TLS terminates at 1Panel and the backend HTTP socket remains loopback-only.
