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
    const payload = (await response.json()) as {
      ok: boolean;
      mode: string;
      persistence: {
        storage: {
          ok: boolean;
          writable: boolean;
          driver: string;
          usedBytes: number;
          quotaBytes: number;
          materialCount: number;
        };
      };
      services: {
        processing: { mode: string; running: number; concurrency: { ai: number; upload: number } };
      };
    };
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, "self-hosted-single-user");
    assert.equal(payload.persistence.storage.ok, true);
    assert.equal(payload.persistence.storage.driver, "local-json-files");
    assert.equal(payload.persistence.storage.writable, true);
    assert.equal(payload.persistence.storage.usedBytes, 0);
    assert.ok(payload.persistence.storage.quotaBytes > 0);
    assert.equal(payload.services.processing.mode, "in-process-queue");
    assert.equal(payload.services.processing.running, 0);
    assert.ok(payload.services.processing.concurrency.ai >= 1);
    assert.equal(JSON.stringify(payload).includes(dataDirectory), false);
  } finally {
    if (previousDataDirectory === undefined) delete process.env.FINALE_DATA_DIR;
    else process.env.FINALE_DATA_DIR = previousDataDirectory;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
