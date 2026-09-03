import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as uploadMaterial } from "../app/api/materials/route";
import { acquireHeavyRequestSlot } from "../lib/runtime-capacity";

test("material upload rejects an oversized declared body before parsing multipart data", async () => {
  const response = await uploadMaterial(new NextRequest("http://localhost/api/materials", {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "content-length": String(56 * 1024 * 1024),
    },
  }));

  assert.equal(response.status, 413);
  assert.match(JSON.stringify(await response.json()), /50 MB/);
});

test("material upload returns a retryable response when the heavy-work pool is full", async () => {
  const releaseFirst = acquireHeavyRequestSlot();
  try {
    const response = await uploadMaterial(new NextRequest("http://localhost/api/materials", {
      method: "POST",
      headers: {
        host: "localhost",
        origin: "http://localhost",
        "content-length": "0",
        "content-type": "multipart/form-data; boundary=capacity-test",
      },
    }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.deepEqual(await response.json(), { error: "服务器正在处理其他大文件，请稍后重试。", code: "SERVER_BUSY" });
  } finally {
    releaseFirst();
  }
});

test("material upload rejects a body without a declared length", async () => {
  const response = await uploadMaterial(new NextRequest("http://localhost/api/materials", {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "content-type": "multipart/form-data; boundary=missing-length",
    },
    body: "--missing-length--",
  }));
  assert.equal(response.status, 411);
});

test("material upload maps malformed multipart input to a client error", async () => {
  const response = await uploadMaterial(new NextRequest("http://localhost/api/materials", {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "content-length": "18",
      "content-type": "multipart/form-data; boundary=broken",
    },
    body: "not-a-multipart-body",
  }));
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /multipart/);
});
