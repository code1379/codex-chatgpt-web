import { expect, test } from "bun:test";
import { isGatewayApiRoute, isGatewayBearerAuthorized } from "../src/gateway";

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
