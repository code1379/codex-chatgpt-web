import { timingSafeEqual, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  atomicWriteFile,
  defaultConfig,
  getConfigDir,
} from "./config";
import {
  browserLoginStateExists,
  loginVerificationMarkerPath,
  sanitizeBrowserLoginStorageState,
} from "./browser-login";
import {
  assertAuthenticatedChatGptPage,
  CHATGPT_NEW_CHAT_URL,
  detectChatGptAccountCapabilities,
} from "./chatgpt-session";
import { startServer } from "./server";
import { availableChatGptWebModelRoutes } from "./chatgpt-web-models";
import { VERSION } from "./version";

const SESSION_COOKIE = "codex_web_gateway_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const VIEWPORT = { width: 1365, height: 900 };

type AdminSession = { expiresAt: number };

function requiredSecret(name: string, minimumLength: number): string {
  const value = process.env[name]?.trim() ?? "";
  if (value.length < minimumLength) {
    throw new Error(name + " must be configured and contain at least " + minimumLength + " characters");
  }
  return value;
}

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(name + " must be an integer between 1 and 65535");
  }
  return value;
}

function constantTimeEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isGatewayBearerAuthorized(header: string | null, apiKey: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  return constantTimeEqual(apiKey, header.slice(prefix.length).trim());
}

export function isGatewayApiRoute(method: string, pathname: string): boolean {
  if (method === "GET" && pathname === "/v1/models") return true;
  if (method === "POST" && [
    "/v1/responses",
    "/v1/responses/compact",
  ].includes(pathname)) return true;
  return false;
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

function originIsSame(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { type: "gateway_error", code, message } }, { status });
}

function secureHeaders(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  result.set("x-content-type-options", "nosniff");
  result.set("x-frame-options", "DENY");
  result.set("referrer-policy", "no-referrer");
  result.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  result.set("cache-control", "no-store");
  return result;
}


type GatewayTurnMetadata = {
  thread_id?: unknown;
  turn_id?: unknown;
  [key: string]: unknown;
};

function validGatewayIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(value);
}

function newGatewayIdentity(prefix: "gw" | "turn"): string {
  return prefix + "_" + randomBytes(18).toString("hex");
}

export function addGatewayTurnMetadata(
  bodyText: string,
  responseThreads: Map<string, string>,
): { bodyText: string; threadId: string; metadataHeader: string } {
  const parsed = JSON.parse(bodyText) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Responses request body must be a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  const clientMetadata = body.client_metadata && typeof body.client_metadata === "object"
    && !Array.isArray(body.client_metadata)
    ? { ...(body.client_metadata as Record<string, unknown>) }
    : {};
  const rawTurnMetadata = clientMetadata["x-codex-turn-metadata"];
  let turnMetadata: GatewayTurnMetadata = {};
  if (typeof rawTurnMetadata === "string") {
    try {
      const decoded = JSON.parse(rawTurnMetadata) as unknown;
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
        turnMetadata = { ...(decoded as GatewayTurnMetadata) };
      }
    } catch {
      // A generic OpenAI client may not send Codex metadata; the Gateway supplies it.
    }
  } else if (rawTurnMetadata && typeof rawTurnMetadata === "object" && !Array.isArray(rawTurnMetadata)) {
    turnMetadata = { ...(rawTurnMetadata as GatewayTurnMetadata) };
  }

  const previousResponseId = typeof body.previous_response_id === "string" ? body.previous_response_id : "";
  const userMetadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : {};
  const conversation = body.conversation && typeof body.conversation === "object" && !Array.isArray(body.conversation)
    ? body.conversation as Record<string, unknown>
    : {};
  const requestedThread = turnMetadata.thread_id
    ?? userMetadata.gateway_thread_id
    ?? conversation.id
    ?? body.conversation_id;
  const threadId = validGatewayIdentity(requestedThread)
    ? requestedThread
    : (previousResponseId && responseThreads.get(previousResponseId)) || newGatewayIdentity("gw");
  const turnId = validGatewayIdentity(turnMetadata.turn_id) ? turnMetadata.turn_id : newGatewayIdentity("turn");
  turnMetadata.thread_id = threadId;
  turnMetadata.turn_id = turnId;
  clientMetadata["x-codex-turn-metadata"] = JSON.stringify(turnMetadata);
  body.client_metadata = clientMetadata;
  const metadataHeader = clientMetadata["x-codex-turn-metadata"] as string;
  return { bodyText: JSON.stringify(body), threadId, metadataHeader };
}

function rememberResponseId(
  value: unknown,
  threadId: string,
  responseThreads: Map<string, string>,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const payload = value as Record<string, unknown>;
  const nested = payload.response && typeof payload.response === "object" && !Array.isArray(payload.response)
    ? payload.response as Record<string, unknown>
    : undefined;
  const id = typeof nested?.id === "string"
    ? nested.id
    : typeof payload.id === "string" && payload.id.startsWith("resp_")
      ? payload.id
      : undefined;
  if (!id) return;
  responseThreads.delete(id);
  responseThreads.set(id, threadId);
  while (responseThreads.size > 4096) {
    const oldest = responseThreads.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    responseThreads.delete(oldest);
  }
}

async function trackResponseThread(
  response: Response,
  threadId: string | undefined,
  responseThreads: Map<string, string>,
): Promise<Response> {
  if (!threadId || !response.body) return response;
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    try {
      rememberResponseId(await response.clone().json(), threadId, responseThreads);
    } catch {
      // Error responses and non-JSON responses do not create continuation state.
    }
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const inspectLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      rememberResponseId(JSON.parse(data) as unknown, threadId, responseThreads);
    } catch {
      // Ignore malformed/non-JSON SSE records while forwarding bytes unchanged.
    }
  };
  const inspect = (chunk: string): void => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) inspectLine(line);
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          inspect(decoder.decode());
          if (pending) inspectLine(pending);
          controller.close();
          return;
        }
        inspect(decoder.decode(item.value, { stream: true }));
        controller.enqueue(item.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: secureHeaders({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    }),
  });
}

function adminHtmlPath(): string {
  const candidates = [
    process.argv[1] ? join(dirname(resolve(process.argv[1])), "gateway-admin.html") : "",
    join(import.meta.dir, "gateway-admin.html"),
    join(import.meta.dir, "../src/gateway-admin.html"),
  ].filter(Boolean);
  const match = candidates.find(candidate => existsSync(candidate));
  if (!match) throw new Error("gateway-admin.html is missing from the runtime bundle");
  return match;
}

function readAdminHtml(): string {
  return readFileSync(adminHtmlPath(), "utf8");
}

function markerCapabilities(config: ReturnType<typeof defaultConfig>): void {
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as {
      solAvailable?: unknown;
      extraHighAvailable?: unknown;
      proAvailable?: unknown;
    };
    config.solAvailable = marker.solAvailable === true;
    config.extraHighAvailable = config.solAvailable && marker.extraHighAvailable === true;
    config.proAvailable = config.solAvailable && marker.proAvailable === true;
  } catch {
    config.solAvailable = false;
    config.extraHighAvailable = false;
    config.proAvailable = false;
  }
}

class RemoteLoginBrowser {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private readonly profileDir: string;

  constructor(private readonly config: ReturnType<typeof defaultConfig>) {
    this.profileDir = join(getConfigDir(), "gateway-browser-profile");
  }

  async start(): Promise<Record<string, unknown>> {
    if (this.page && !this.page.isClosed()) return this.status();
    mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    const storageState = browserLoginStateExists(this.config) ? this.config.storageStatePath : undefined;
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      executablePath: this.config.chromeExecutablePath,
      headless: false,
      viewport: VIEWPORT,
      acceptDownloads: false,
      ...(storageState ? { storageState } : {}),
      args: [
        // The container drops Linux capabilities and sets no-new-privileges; use the
        // container boundary rather than Chromium's setuid/user-namespace sandbox.
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
      ],
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.page.goto(CHATGPT_NEW_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    return this.status();
  }

  async status(): Promise<Record<string, unknown>> {
    const page = this.page && !this.page.isClosed() ? this.page : undefined;
    let liveAuthenticated = false;
    if (page) {
      liveAuthenticated = await page.locator('[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][data-lexical-editor="true"]')
        .first().isVisible().catch(() => false);
    }
    return {
      running: Boolean(page),
      url: page ? new URL(page.url()).origin === "https://chatgpt.com" ? page.url() : "external-auth-page" : null,
      title: page ? await page.title().catch(() => "") : "",
      liveAuthenticated,
      saved: browserLoginStateExists(this.config),
    };
  }

  async screenshot(): Promise<Buffer> {
    const page = this.page && !this.page.isClosed() ? this.page : undefined;
    if (!page) throw new Error("Start the browser login session first");
    return await page.screenshot({ type: "png", animations: "disabled" });
  }

  async action(payload: unknown): Promise<Record<string, unknown>> {
    const page = this.page && !this.page.isClosed() ? this.page : undefined;
    if (!page) throw new Error("Start the browser login session first");
    if (!payload || typeof payload !== "object") throw new Error("Invalid browser action");
    const action = payload as Record<string, unknown>;
    if (action.type === "click") {
      const x = Number(action.x);
      const y = Number(action.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > VIEWPORT.width || y > VIEWPORT.height) {
        throw new Error("Click coordinates are outside the browser viewport");
      }
      await page.mouse.click(x, y);
    } else if (action.type === "type") {
      if (typeof action.text !== "string" || action.text.length > 2000) throw new Error("Text input is invalid or too long");
      await page.keyboard.type(action.text);
    } else if (action.type === "press") {
      if (typeof action.key !== "string" || !/^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Control\\+A|Control\\+C|Control\\+V|Control\\+X|Control\\+Z|Shift\\+Tab)$/.test(action.key)) {
        throw new Error("Keyboard shortcut is not allowed");
      }
      await page.keyboard.press(action.key);
    } else if (action.type === "scroll") {
      const x = Number(action.x ?? VIEWPORT.width / 2);
      const y = Number(action.y ?? VIEWPORT.height / 2);
      const deltaY = Number(action.deltaY ?? 0);
      const deltaX = Number(action.deltaX ?? 0);
      if (![x, y, deltaX, deltaY].every(Number.isFinite) || Math.abs(deltaY) > 1500 || Math.abs(deltaX) > 1500) {
        throw new Error("Scroll values are invalid");
      }
      await page.mouse.move(x, y);
      await page.mouse.wheel(deltaX, deltaY);
    } else if (action.type === "reload") {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    } else if (action.type === "back") {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    } else {
      throw new Error("Unsupported browser action");
    }
    return this.status();
  }

  async save(): Promise<Record<string, unknown>> {
    const page = this.page && !this.page.isClosed() ? this.page : undefined;
    const context = this.context;
    if (!page || !context) throw new Error("Start the browser login session first");
    if (new URL(page.url()).origin !== "https://chatgpt.com") {
      throw new Error("Finish sign-in and return to chatgpt.com before saving the session");
    }
    await assertAuthenticatedChatGptPage(page);
    const state = sanitizeBrowserLoginStorageState(await context.storageState());
    if (state.cookies.length === 0) throw new Error("No ChatGPT/OpenAI session cookies were found; sign-in was not saved");
    let capabilities = { solAvailable: false, extraHighAvailable: false, proAvailable: false };
    try {
      capabilities = await detectChatGptAccountCapabilities(page, { selectorTimeoutMs: 10000, stableAbsenceMs: 2000 });
    } catch {
      // A successful login remains useful even if the model-picker capability probe times out.
    }
    atomicWriteFile(this.config.storageStatePath, JSON.stringify(state) + "\n", { mode: 0o600 });
    atomicWriteFile(loginVerificationMarkerPath(this.config.storageStatePath), JSON.stringify({
      version: 1,
      authenticated: true,
      verifiedAt: new Date().toISOString(),
      solAvailable: capabilities.solAvailable,
      extraHighAvailable: capabilities.extraHighAvailable,
      proAvailable: capabilities.proAvailable,
    }) + "\n", { mode: 0o600 });
    this.config.solAvailable = capabilities.solAvailable;
    this.config.extraHighAvailable = capabilities.solAvailable && capabilities.extraHighAvailable;
    this.config.proAvailable = capabilities.solAvailable && capabilities.proAvailable;
    return this.status();
  }

  async stop(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    if (context) await context.close().catch(() => {});
  }

  async clear(): Promise<void> {
    await this.stop();
    rmSync(this.config.storageStatePath, { force: true });
    rmSync(loginVerificationMarkerPath(this.config.storageStatePath), { force: true });
    rmSync(this.profileDir, { recursive: true, force: true });
    this.config.solAvailable = false;
    this.config.extraHighAvailable = false;
    this.config.proAvailable = false;
  }
}

function sessionFromRequest(request: Request, sessions: Map<string, AdminSession>): string | undefined {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return undefined;
  const session = sessions.get(token);
  if (!session) return undefined;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return token;
}

function cookieHeader(token: string, secure: boolean): string {
  return SESSION_COOKIE + "=" + encodeURIComponent(token) + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" +
    Math.floor(SESSION_TTL_MS / 1000) + (secure ? "; Secure" : "");
}

function clearCookieHeader(secure: boolean): string {
  return SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + (secure ? "; Secure" : "");
}

function allowedResponseHeaders(source: Headers): Headers {
  const result = new Headers();
  for (const [name, value] of source.entries()) {
    const lower = name.toLowerCase();
    if (["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding", "set-cookie"].includes(lower)) continue;
    result.set(name, value);
  }
  return result;
}

export async function runGateway(): Promise<void> {
  const apiKey = requiredSecret("GATEWAY_API_KEY", 32);
  const adminPassword = requiredSecret("GATEWAY_ADMIN_PASSWORD", 16);
  const host = process.env.GATEWAY_HOST?.trim() || "0.0.0.0";
  const port = integerEnv("GATEWAY_PORT", 17840);
  const internalPort = integerEnv("GATEWAY_INTERNAL_PORT", 17841);
  if (port === internalPort) throw new Error("GATEWAY_PORT and GATEWAY_INTERNAL_PORT must be different");
  const certPath = process.env.GATEWAY_TLS_CERT_FILE?.trim();
  const keyPath = process.env.GATEWAY_TLS_KEY_FILE?.trim();
  if (Boolean(certPath) !== Boolean(keyPath)) throw new Error("Configure both GATEWAY_TLS_CERT_FILE and GATEWAY_TLS_KEY_FILE");
  const tls = certPath && keyPath
    ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
    : undefined;
  const isPublicBind = host !== "127.0.0.1" && host !== "::1" && host !== "localhost";
  if (isPublicBind && !tls && process.env.GATEWAY_ALLOW_INSECURE_HTTP !== "true") {
    throw new Error("Public binding requires TLS. Configure GATEWAY_TLS_CERT_FILE and GATEWAY_TLS_KEY_FILE; only set GATEWAY_ALLOW_INSECURE_HTTP=true for a tightly IP-restricted test.");
  }

  const dataHome = process.env.CODEX_CHATGPT_WEB_HOME?.trim() || "/data";
  process.env.CODEX_CHATGPT_WEB_HOME = dataHome;
  mkdirSync(dataHome, { recursive: true, mode: 0o700 });

  const config = defaultConfig("browser-only");
  config.host = "127.0.0.1";
  config.port = internalPort;
  // The remote login browser is headed under Xvfb; model turns use headless Chromium.
  config.headed = false;
  config.chromeExecutablePath = process.env.GATEWAY_CHROMIUM_PATH?.trim() || process.env.CHROME_BIN?.trim() || "/usr/bin/chromium";
  markerCapabilities(config);

  const coreServer = startServer(config, { disableSignalHandlers: true });
  const browser = new RemoteLoginBrowser(config);
  const sessions = new Map<string, AdminSession>();
  const responseThreads = new Map<string, string>();
  let publicServer!: ReturnType<typeof Bun.serve>;
  const loginFailures = new Map<string, { count: number; windowStartedAt: number; blockedUntil: number }>();
  let shuttingDown = false;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>(resolvePromise => { resolveStopped = resolvePromise; });

  publicServer = Bun.serve({
    hostname: host,
    port,
    idleTimeout: 0,
    ...(tls ? { tls } : {}),
    async fetch(request) {
      const url = new URL(request.url);
      const secure = url.protocol === "https:" || Boolean(tls);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ status: "ok", service: "codex-chatgpt-web-gateway", version: VERSION }, {
          headers: secureHeaders(),
        });
      }

      if (request.method === "POST" && url.pathname === "/admin/login") {
        if (!originIsSame(request)) return jsonError(403, "origin_rejected", "Login request must be same-origin");
        const declaredLength = Number(request.headers.get("content-length") ?? "0");
        if (declaredLength > 4096) return jsonError(413, "request_too_large", "Login request is too large");
        const clientAddress = publicServer.requestIP(request)?.address ?? "unknown";
        const now = Date.now();
        let failures = loginFailures.get(clientAddress);
        if (!failures || now - failures.windowStartedAt > 15 * 60_000) {
          failures = { count: 0, windowStartedAt: now, blockedUntil: 0 };
          loginFailures.set(clientAddress, failures);
        }
        if (failures.blockedUntil > now) {
          return new Response(JSON.stringify({ error: { type: "gateway_error", code: "login_rate_limited", message: "Too many failed login attempts; wait before trying again" } }), {
            status: 429,
            headers: secureHeaders({ "content-type": "application/json", "retry-after": String(Math.ceil((failures.blockedUntil - now) / 1000)) }),
          });
        }
        let password: unknown;
        try {
          const body = await request.json() as { password?: unknown };
          password = body.password;
        } catch {
          return jsonError(400, "invalid_json", "Request body must be JSON");
        }
        if (typeof password !== "string" || !constantTimeEqual(adminPassword, password)) {
          failures.count += 1;
          if (failures.count >= 8) failures.blockedUntil = now + 15 * 60_000;
          await Bun.sleep(350);
          return jsonError(401, "invalid_credentials", "Invalid administrator password");
        }
        loginFailures.delete(clientAddress);
        for (const [token, session] of sessions) {
          if (session.expiresAt <= now) sessions.delete(token);
        }
        if (sessions.size >= 32) return jsonError(429, "too_many_sessions", "Too many administrator sessions are active");
        const token = randomBytes(32).toString("base64url");
        sessions.set(token, { expiresAt: now + SESSION_TTL_MS });
        return Response.json({ status: "ok" }, {
          headers: secureHeaders({ "set-cookie": cookieHeader(token, secure) }),
        });
      }

      if (request.method === "GET" && url.pathname === "/") {
        const token = sessionFromRequest(request, sessions);
        return htmlResponse(token ? readAdminHtml() : readAdminHtml().replace("<!-- ADMIN_APP -->", "").replace("<!-- LOGIN_APP -->", ""));
      }

      if (request.method === "POST" && url.pathname === "/admin/logout") {
        if (!originIsSame(request)) return jsonError(403, "origin_rejected", "Logout request must be same-origin");
        const token = sessionFromRequest(request, sessions);
        if (token) sessions.delete(token);
        return Response.json({ status: "ok" }, { headers: secureHeaders({ "set-cookie": clearCookieHeader(secure) }) });
      }

      const adminToken = sessionFromRequest(request, sessions);
      if (url.pathname.startsWith("/admin/")) {
        if (!adminToken) return jsonError(401, "admin_auth_required", "Administrator login required");
        if (request.method !== "GET" && !originIsSame(request)) {
          return jsonError(403, "origin_rejected", "Administrative requests must be same-origin");
        }
        if (request.method === "GET" && url.pathname === "/admin/status") {
          return Response.json({
            service: "codex-chatgpt-web-gateway",
            version: VERSION,
            savedSession: browserLoginStateExists(config),
            browser: await browser.status(),
          }, { headers: secureHeaders() });
        }
        if (request.method === "POST" && url.pathname === "/admin/browser/start") {
          try {
            return Response.json({ status: "ok", browser: await browser.start() }, { headers: secureHeaders() });
          } catch (error) {
            return jsonError(502, "browser_start_failed", error instanceof Error ? error.message : String(error));
          }
        }
        if (request.method === "GET" && url.pathname === "/admin/browser/screenshot") {
          try {
            return new Response(await browser.screenshot(), {
              headers: secureHeaders({ "content-type": "image/png" }),
            });
          } catch (error) {
            return jsonError(409, "browser_not_running", error instanceof Error ? error.message : String(error));
          }
        }
        if (request.method === "POST" && url.pathname === "/admin/browser/action") {
          let payload: unknown;
          try {
            const declaredLength = Number(request.headers.get("content-length") ?? "0");
            if (declaredLength > 16_000) return jsonError(413, "action_too_large", "Browser action is too large");
            const raw = await request.text();
            if (raw.length > 16_000) return jsonError(413, "action_too_large", "Browser action is too large");
            payload = JSON.parse(raw);
            return Response.json({ status: "ok", browser: await browser.action(payload) }, { headers: secureHeaders() });
          } catch (error) {
            return jsonError(400, "browser_action_failed", error instanceof Error ? error.message : String(error));
          }
        }
        if (request.method === "POST" && url.pathname === "/admin/browser/save") {
          try {
            return Response.json({ status: "ok", browser: await browser.save() }, { headers: secureHeaders() });
          } catch (error) {
            return jsonError(400, "session_save_failed", error instanceof Error ? error.message : String(error));
          }
        }
        if (request.method === "POST" && url.pathname === "/admin/browser/stop") {
          await browser.stop();
          return Response.json({ status: "ok" }, { headers: secureHeaders() });
        }
        if (request.method === "POST" && url.pathname === "/admin/browser/clear") {
          await browser.clear();
          return Response.json({ status: "ok" }, { headers: secureHeaders() });
        }
        return jsonError(404, "not_found", "Administrative endpoint not found");
      }

      if (url.pathname.startsWith("/v1/")) {
        if (!isGatewayApiRoute(request.method, url.pathname)) return jsonError(404, "not_found", "API endpoint not found");
        if (!isGatewayBearerAuthorized(request.headers.get("authorization"), apiKey)) {
          return jsonError(401, "invalid_api_key", "A valid Gateway API bearer key is required");
        }
        const declaredLength = Number(request.headers.get("content-length") ?? "0");
        if (declaredLength > MAX_REQUEST_BYTES) return jsonError(413, "request_too_large", "Request body exceeds Gateway limit");
        const headers = new Headers(request.headers);
        headers.delete("authorization");
        headers.delete("origin");
        headers.delete("host");
        headers.delete("cookie");
        headers.delete("content-length");
        if (request.method === "GET" && url.pathname === "/v1/models") {
          if (!browserLoginStateExists(config)) {
            return jsonError(503, "chatgpt_login_required", "Complete ChatGPT Web login in the Gateway admin page first");
          }
          const data = availableChatGptWebModelRoutes(config, true).map(route => ({
            id: route.slug,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "chatgpt-web",
            display_name: route.displayName,
          }));
          return Response.json({ object: "list", data }, { headers: secureHeaders() });
        }

        let body: BodyInit | undefined;
        let threadId: string | undefined;
        if (request.method !== "GET" && request.method !== "HEAD") {
          const rawBody = await request.arrayBuffer();
          if (rawBody.byteLength > MAX_REQUEST_BYTES) return jsonError(413, "request_too_large", "Request body exceeds Gateway limit");
          if (request.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/v1/responses/compact")) {
            try {
              const rawText = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
              const input = JSON.parse(rawText) as unknown;
              if (!input || typeof input !== "object" || Array.isArray(input)) {
                return jsonError(400, "invalid_responses_request", "Responses request body must be a JSON object");
              }
              const model = (input as Record<string, unknown>).model;
              const allowedModels = new Set(availableChatGptWebModelRoutes(config, true).map(route => route.slug));
              if (typeof model !== "string" || !allowedModels.has(model)) {
                return jsonError(400, "unsupported_model", "Use a model ID returned by GET /v1/models");
              }
              const decorated = addGatewayTurnMetadata(rawText, responseThreads);
              body = decorated.bodyText;
              threadId = decorated.threadId;
              headers.set("x-codex-turn-metadata", decorated.metadataHeader);
              headers.set("content-type", "application/json");
              headers.delete("content-encoding");
            } catch (error) {
              return jsonError(400, "invalid_responses_request", error instanceof Error ? error.message : "Invalid Responses request body");
            }
          } else {
            body = rawBody;
          }
        }
        const upstreamRequest = new Request("http://127.0.0.1:" + coreServer.port + url.pathname + url.search, {
          method: request.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: request.signal,
        });
        try {
          const upstream = await fetch(upstreamRequest);
          const cleaned = new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: allowedResponseHeaders(upstream.headers),
          });
          return await trackResponseThread(cleaned, threadId, responseThreads);
        } catch {
          return jsonError(502, "upstream_unavailable", "The internal Responses service could not be reached");
        }
      }

      return jsonError(404, "not_found", "Route not found");
    },
  });

  console.log("[codex-web-gateway] version " + VERSION + " listening on " + (tls ? "https://" : "http://") + host + ":" + publicServer.port);
  console.log("[codex-web-gateway] internal Responses service bound to 127.0.0.1:" + coreServer.port);
  console.log("[codex-web-gateway] administrator and API secrets loaded; secret values are never logged");

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    sessions.clear();
    await browser.stop();
    try {
      await fetch("http://127.0.0.1:" + coreServer.port + "/admin/drain", {
        method: "POST",
        headers: { authorization: "Bearer " + config.controlToken },
      });
      const deadline = Date.now() + 30000;
      let idle = false;
      while (Date.now() < deadline) {
        const health = await fetch("http://127.0.0.1:" + coreServer.port + "/healthz").then(response => response.json() as Promise<Record<string, unknown>>).catch(() => ({}));
        if (health.active_http_turns === 0 && health.active_browser_turns === 0) {
          idle = true;
          break;
        }
        await Bun.sleep(250);
      }
      if (idle) {
        const response = await fetch("http://127.0.0.1:" + coreServer.port + "/admin/shutdown", {
          method: "POST",
          headers: { authorization: "Bearer " + config.controlToken },
        });
        if (!response.ok) coreServer.stop(true);
      } else {
        coreServer.stop(true);
      }
    } catch {
      coreServer.stop(true);
    }
    await publicServer.stop(true);
    resolveStopped?.();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  await stopped;
}
