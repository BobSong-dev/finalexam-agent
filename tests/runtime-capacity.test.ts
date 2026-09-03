import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeCapacityError, acquireHeavyRequestSlot } from "../lib/runtime-capacity";

test("memory-heavy uploads and analyses share a bounded process-local pool", () => {
  const releaseFirst = acquireHeavyRequestSlot();
  try {
    assert.throws(() => acquireHeavyRequestSlot(), (error: unknown) => {
      assert.ok(error instanceof RuntimeCapacityError);
      assert.equal(error.retryAfterSeconds, 5);
      return true;
    });
  } finally {
    releaseFirst();
  }

  const releaseAfterRecovery = acquireHeavyRequestSlot();
  releaseAfterRecovery();
  releaseAfterRecovery();
});
