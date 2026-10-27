import { expect, test } from "bun:test";
import { effectiveRequestUrl, isGatewayApiRoute, isGatewayBearerAuthorized } from "../src/gateway";

test("Gateway requires exact Bearer authentication for API routes", () => {
  const key = "test-gateway-key-that-is-long-enough-for-unit-testing";
  expect(isGatewayBearerAuthorized("Bearer " + key, key)).toBe(true);
  expect(isGatewayBearerAuthorized("bearer " + key, key)).toBe(false);
  expect(isGatewayBearerAuthorized("Bearer wrong", key)).toBe(false);
  expect(isGatewayBearerAuthorized(null, key)).toBe(false);
});

test("Gateway only proxies its explicit API allowlist", () => {
  expect(isGatewayApiRoute("GET", "/v1/models")).toBe(true);
  expect(isGatewayApiRoute("POST", "/v1/responses")).toBe(true);
  expect(isGatewayApiRoute("POST", "/v1/responses/compact")).toBe(true);
  expect(isGatewayApiRoute("POST", "/v1/admin")).toBe(false);
  expect(isGatewayApiRoute("DELETE", "/v1/responses")).toBe(false);
  expect(isGatewayApiRoute("GET", "/v1/unknown")).toBe(false);
});

test("Gateway supplies native Codex turn metadata for generic Responses clients", async () => {
  const { addGatewayTurnMetadata } = await import("../src/gateway");
  const threads = new Map<string, string>();
  const first = addGatewayTurnMetadata(JSON.stringify({
    model: "chatgpt-web/gpt-5.6-sol",
    input: "hello",
    stream: true,
  }), threads);
  const firstBody = JSON.parse(first.bodyText);
  const firstMetadata = JSON.parse(firstBody.client_metadata["x-codex-turn-metadata"]);
  expect(firstMetadata.thread_id).toBe(first.threadId);
  expect(firstMetadata.turn_id).toMatch(/^turn_[a-f0-9]{36}$/);
  expect(first.metadataHeader).toBe(firstBody.client_metadata["x-codex-turn-metadata"]);

  threads.set("resp_test_123", first.threadId);
  const second = addGatewayTurnMetadata(JSON.stringify({
    model: "chatgpt-web/gpt-5.6-sol",
    previous_response_id: "resp_test_123",
    input: "continue",
  }), threads);
  const secondBody = JSON.parse(second.bodyText);
  const secondMetadata = JSON.parse(secondBody.client_metadata["x-codex-turn-metadata"]);
  expect(second.threadId).toBe(first.threadId);
  expect(secondMetadata.turn_id).not.toBe(firstMetadata.turn_id);
});

test("Gateway rejects malformed or non-object Responses JSON", async () => {
  const { addGatewayTurnMetadata } = await import("../src/gateway");
  expect(() => addGatewayTurnMetadata("{", new Map())).toThrow();
  expect(() => addGatewayTurnMetadata("[]", new Map())).toThrow("Responses request body must be a JSON object");
});

test("Gateway recognizes HTTPS from the configured reverse proxy", () => {
  const previous = process.env.GATEWAY_TRUST_PROXY;
  try {
    process.env.GATEWAY_TRUST_PROXY = "true";
    const request = new Request("http://127.0.0.1:17840/admin/login", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(effectiveRequestUrl(request).protocol).toBe("https:");
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_TRUST_PROXY;
    else process.env.GATEWAY_TRUST_PROXY = previous;
  }
});

test("Gateway ignores forwarded scheme when trusted proxy mode is disabled", () => {
  const previous = process.env.GATEWAY_TRUST_PROXY;
  try {
    delete process.env.GATEWAY_TRUST_PROXY;
    const request = new Request("http://127.0.0.1:17840/admin/login", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(effectiveRequestUrl(request).protocol).toBe("http:");
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_TRUST_PROXY;
    else process.env.GATEWAY_TRUST_PROXY = previous;
  }
});
