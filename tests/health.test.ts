import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GET } from "../app/api/health/route";
import { GET as getLiveness } from "../app/api/live/route";

test("liveness stays lightweight and explicitly non-cacheable", async () => {
  const response = getLiveness();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true });
});

test("health reports a writable self-hosted workspace without exposing its data path", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "finale-health-test-"));
  const previousDataDirectory = process.env.FINALE_DATA_DIR;
  process.env.FINALE_DATA_DIR = dataDirectory;

  try {
    const response = await GET();
    const payload = await response.json() as {
      ok: boolean;
      mode: string;
      persistence: { storage: { writable: boolean; driver: string } };
    };
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, "self-hosted-single-user");
    assert.deepEqual(payload.persistence.storage, { ok: true, driver: "local-json-files", writable: true });
    assert.equal(JSON.stringify(payload).includes(dataDirectory), false);
  } finally {
    if (previousDataDirectory === undefined) delete process.env.FINALE_DATA_DIR;
    else process.env.FINALE_DATA_DIR = previousDataDirectory;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
