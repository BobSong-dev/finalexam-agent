import { NextResponse } from "next/server";
import { getServerAiStatus } from "@/lib/ai-analysis";
import {
  getStorageUsage,
  checkWorkspaceStorage,
  getProcessingSnapshot,
  getWorkspace,
} from "@/lib/workspace-store";
import { aiPool, uploadPool } from "@/lib/runtime-capacity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StorageProbe =
  | { ok: true; driver: "local-json-files"; writable: true }
  | { ok: false; driver: "local-json-files"; writable: false; error: "unavailable" };

async function probeWorkspaceStorage(): Promise<StorageProbe> {
  try {
    // getWorkspace creates the configured directory on first boot; access then
    // verifies that the non-root runtime user can actually write to it. Do not
    // include its path in the response: health is intentionally safe to expose.
    await getWorkspace();
    await checkWorkspaceStorage();
    return { ok: true, driver: "local-json-files", writable: true };
  } catch {
    return { ok: false, driver: "local-json-files", writable: false, error: "unavailable" };
  }
}

export async function GET() {
  const storage = await probeWorkspaceStorage();
  const ai = getServerAiStatus();
  const ok = storage.ok;
  const databaseConfiguredButInactive = Boolean(process.env.DATABASE_URL?.trim());
  const usage = storage.ok ? await getStorageUsage().catch(() => undefined) : undefined;
  const jobs = storage.ok
    ? await getProcessingSnapshot()
        .then((snapshot) => snapshot.jobs)
        .catch(() => [])
    : [];

  return NextResponse.json(
    {
      ok,
      mode: "self-hosted-single-user",
      persistence: {
        storage: {
          ...storage,
          ...(usage
            ? {
                usedBytes: usage.usedBytes,
                quotaBytes: usage.quotaBytes,
                materialCount: usage.materialCount,
              }
            : {}),
        },
        database: {
          mode: databaseConfiguredButInactive ? "configured-but-inactive" : "not-configured",
          active: false,
          note: "This binary ignores DATABASE_URL. Persistence is local JSON and uploaded files; PostgreSQL is an adapter target, not connected.",
        },
      },
      services: {
        ai: {
          configured: ai.configured,
          keySource: ai.source,
          defaultModel: ai.defaultModel,
        },
        processing: {
          mode: "in-process-queue",
          running: jobs.length,
          stages: jobs.map((job) => ({ type: job.type, stage: job.stage })),
          concurrency: { ai: aiPool().limit, upload: uploadPool().limit },
        },
      },
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
