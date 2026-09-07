import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { RequestSecurityError, assertCommunityAdmin, assertNotCrossSite, assertSameOrigin, timingSafeEqualText } from "../lib/http-security";

test("Origin checks ignore spoofed forwarded hosts unless the proxy is trusted", () => {
  const spoofed = new NextRequest("http://localhost/api/workspace", {
    headers: { origin: "https://evil.example", "x-forwarded-host": "evil.example" },
  });
  assert.throws(() => assertSameOrigin(spoofed), RequestSecurityError);
  const previous = process.env.FINALE_TRUST_PROXY;
  process.env.FINALE_TRUST_PROXY = "true";
  try {
    assert.doesNotThrow(() => assertSameOrigin(spoofed));
  } finally {
    if (previous === undefined) delete process.env.FINALE_TRUST_PROXY;
    else process.env.FINALE_TRUST_PROXY = previous;
  }
});

test("cross-site navigations cannot trigger downloads or exports", () => {
  const crossSite = new NextRequest("http://localhost/api/workspace/export", {
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.throws(() => assertNotCrossSite(crossSite), RequestSecurityError);
  const local = new NextRequest("http://localhost/api/workspace/export");
  assert.doesNotThrow(() => assertNotCrossSite(local));
});

test("admin bearer comparison is length-safe", () => {
  const previous = process.env.COMMUNITY_ADMIN_TOKEN;
  process.env.COMMUNITY_ADMIN_TOKEN = "test-admin-token";
  try {
    assert.throws(
      () => assertCommunityAdmin(new NextRequest("http://localhost/api/shared/moderate")),
      RequestSecurityError,
    );
    const ok = new NextRequest("http://localhost/api/shared/moderate", {
      headers: { authorization: "Bearer test-admin-token" },
    });
    assert.doesNotThrow(() => assertCommunityAdmin(ok));
    assert.equal(timingSafeEqualText("abc", "abc"), true);
    assert.equal(timingSafeEqualText("abc", "abd"), false);
    assert.equal(timingSafeEqualText("abc", "ab"), false);
  } finally {
    if (previous === undefined) delete process.env.COMMUNITY_ADMIN_TOKEN;
    else process.env.COMMUNITY_ADMIN_TOKEN = previous;
  }
});
