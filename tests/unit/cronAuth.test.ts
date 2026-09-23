import { describe, expect, it } from "vitest";
import { isAuthorizedCronRequest } from "../../src/services/scheduling/cronAuth.js";

describe("isAuthorizedCronRequest", () => {
  const secret = "test-secret-value-123";

  it("accepts a correct bearer token", () => {
    expect(isAuthorizedCronRequest(`Bearer ${secret}`, secret)).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(isAuthorizedCronRequest("Bearer wrong-value", secret)).toBe(false);
  });

  it("rejects a wrong token of a different length (timing-safe compare's early-exit path)", () => {
    expect(isAuthorizedCronRequest("Bearer short", secret)).toBe(false);
  });

  it("fails closed when CRON_SECRET is unset — never authorizes an unconfigured deployment", () => {
    expect(isAuthorizedCronRequest(`Bearer ${secret}`, undefined)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${secret}`, "")).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    expect(isAuthorizedCronRequest(undefined, secret)).toBe(false);
  });

  it("rejects the wrong scheme", () => {
    expect(isAuthorizedCronRequest(`Basic ${secret}`, secret)).toBe(false);
  });

  it("rejects a bare token with no scheme", () => {
    expect(isAuthorizedCronRequest(secret, secret)).toBe(false);
  });

  it("handles the header arriving as a string array (Node's raw header shape)", () => {
    expect(isAuthorizedCronRequest([`Bearer ${secret}`], secret)).toBe(true);
  });
});
