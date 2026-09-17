import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Semaphore, aiPool, uploadPool, RuntimeCapacityError } from "../lib/runtime-capacity";
import {
  clearProcessingFailure,
  createCourse,
  getProcessingSnapshot,
  getWorkspace,
  recordProcessingFailure,
  recoverInterruptedWork,
  storeUploadedMaterial,
} from "../lib/workspace-store";

const temporaryDataDirectory = path.join(os.tmpdir(), `finale-jobs-${process.pid}-${randomUUID()}`);
const previousDataDirectory = process.env.FINALE_DATA_DIR;
process.env.FINALE_DATA_DIR = temporaryDataDirectory;

test.after(async () => {
  if (previousDataDirectory === undefined) delete process.env.FINALE_DATA_DIR;
  else process.env.FINALE_DATA_DIR = previousDataDirectory;
  await rm(temporaryDataDirectory, { recursive: true, force: true });
});

test("a crashed run does not leave a material stuck in 分析中 or a stale job behind", async () => {
  const directory = path.join(os.tmpdir(), `finale-stale-${process.pid}-${randomUUID()}`);
  await mkdir(path.join(directory, "uploads"), { recursive: true });
  const courseId = "course-stale";
  const materialId = "material-stale";
  const state = {
    version: 2,
    updatedAt: "2026-01-01T00:00:00.000Z",
    planSource: "schedule",
    planGenerationLease: {
      runId: "dead-run",
      inputHash: "x",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
    profile: {
      id: "local-workspace",
      displayName: "",
      email: "",
      school: "",
      verified: false,
      credits: 0,
      examGoal: "",
      timezone: "Asia/Shanghai",
      studyDayStart: "18:30",
    },
    courses: [
      {
        id: courseId,
        name: "线代",
        code: "LA",
        teacher: "t",
        term: "2026",
        examDate: "2099-01-01",
        priority: "高",
        mastery: 0,
        highFrequencyWeight: 0.5,
        color: "#000",
      },
    ],
    availability: [],
    materials: [
      {
        id: materialId,
        courseId,
        name: "期末.pdf",
        kind: "试卷",
        pages: 0,
        status: "分析中",
        source: "已发送给 AI 分析",
        shared: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        objectKey: `${materialId}.pdf`,
        sha256: "a".repeat(64),
        uploadedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        analysisLease: { runId: "dead-run", startedAt: "2026-01-01T00:00:00.000Z" },
      },
    ],
    insights: [],
    questions: [],
    tasks: [],
    sharedMaterials: [],
    ledger: [],
    documentAnalyses: {},
    courseSyntheses: {},
    assessmentAttempts: [],
    knowledgeMastery: {},
    practiceSessions: [],
    auditLog: [],
    sharedMaterialRecords: [],
    sharedReports: [],
    unlockGrants: [],
    otpChallenges: [],
    missedTasks: [],
    processingJobs: [
      {
        id: `analyze:${materialId}`,
        type: "analyze",
        targetId: materialId,
        stage: "calling-model",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        bootId: "dead-boot",
      },
    ],
    processingErrors: [],
  };
  await writeFile(path.join(directory, "workspace.json"), JSON.stringify(state), "utf8");
  const previous = process.env.FINALE_DATA_DIR;
  process.env.FINALE_DATA_DIR = directory;
  try {
    const result = await recoverInterruptedWork();
    assert.equal(result.interruptedMaterials, 1);
    assert.equal(result.interruptedJobs, 1);
    const recovered = await getWorkspace();
    const material = recovered.materials[0]!;
    assert.equal(material.status, "失败");
    assert.equal(material.analysisLease, undefined);
    assert.match(material.error ?? "", /重启/);
    assert.equal(recovered.processingJobs?.length, 0);
    assert.equal(recovered.planGenerationLease, undefined);
    assert.ok(
      (recovered.processingErrors ?? []).some((item) => item.id === `analyze:${materialId}`),
    );
    assert.ok((recovered.processingErrors ?? []).some((item) => item.id === "plan:generate"));

    const snapshot = await getProcessingSnapshot();
    assert.equal(snapshot.active, false);
    const second = await recoverInterruptedWork();
    assert.equal(second.interruptedMaterials, 0, "recovery is idempotent");
    assert.equal(snapshot.signal.length, 32);
  } finally {
    process.env.FINALE_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("uploads are not blocked by a running analysis (separate pools)", () => {
  const releaseAi = aiPool().tryAcquire();
  try {
    // 旧实现里上传与 AI 共用一个槽位，这里必须仍然可以拿到上传槽位。
    const releaseUpload = uploadPool().tryAcquire();
    releaseUpload();
    assert.equal(aiPool().activeCount, 1);
  } finally {
    releaseAi();
  }
});

test("a bounded semaphore queues waiters and hands the slot over without dropping the count", async () => {
  const semaphore = new Semaphore(1);
  const release = semaphore.tryAcquire();
  assert.throws(
    () => semaphore.tryAcquire(),
    (error: unknown) => error instanceof RuntimeCapacityError,
  );

  const waiting = semaphore.acquire(1_000);
  assert.equal(semaphore.queuedCount, 1);
  release();
  const releaseSecond = await waiting;
  assert.equal(semaphore.activeCount, 1, "the handed-over slot keeps exactly one active holder");
  releaseSecond();
  assert.equal(semaphore.activeCount, 0);

  await assert.rejects(
    () => {
      const held = semaphore.tryAcquire();
      return semaphore.acquire(20).finally(() => held());
    },
    (error: unknown) => error instanceof RuntimeCapacityError,
    "a waiter that times out reports SERVER_BUSY",
  );
  assert.equal(semaphore.queuedCount, 0);
  semaphore.resetForTests();
});

test("processing failures are recorded once and cleared on success", async () => {
  const { course } = await createCourse({
    name: "概率论",
    code: "PROB-JOB-1",
    teacher: "测试老师",
    term: "2026 秋",
    examDate: "2099-12-30",
    priority: "中",
  });
  await storeUploadedMaterial(
    course.id,
    new File([Buffer.from("%PDF-mock\njobs")], "jobs.pdf", { type: "application/pdf" }),
  );
  const snapshot = await getProcessingSnapshot();
  const materialId = snapshot.signal ? (await getWorkspace()).materials[0]!.id : "";

  await recordProcessingFailure({
    id: `synthesize:${course.id}`,
    type: "synthesize",
    targetId: course.id,
    message: "provider 502",
  });
  await recordProcessingFailure({
    id: `synthesize:${course.id}`,
    type: "synthesize",
    targetId: course.id,
    message: "provider 502",
  });
  let state = await getWorkspace();
  assert.equal(
    (state.processingErrors ?? []).filter((item) => item.id === `synthesize:${course.id}`).length,
    1,
    "identical repeats are not duplicated",
  );

  await recordProcessingFailure({
    id: `analyze:${materialId}`,
    type: "analyze",
    targetId: materialId,
    message: "密钥无效",
  });
  state = await getWorkspace();
  assert.equal(state.processingErrors?.length, 2);
  assert.equal(JSON.stringify(state).includes("sk-"), false);

  await clearProcessingFailure(`synthesize:${course.id}`);
  state = await getWorkspace();
  assert.equal(
    (state.processingErrors ?? []).some((item) => item.id === `synthesize:${course.id}`),
    false,
  );
});

test("the jobs endpoint reports stages without leaking analysis payloads", async () => {
  const { GET } = await import("../app/api/jobs/route");
  const response = await GET(
    new (await import("next/server")).NextRequest("http://localhost/api/jobs"),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    jobs: unknown[];
    errors: unknown[];
    active: boolean;
    signal: string;
  };
  assert.equal(payload.active, false);
  assert.equal(payload.signal.length, 32);
  assert.equal("documentAnalyses" in payload, false);
  const raw = await readFile(path.join(temporaryDataDirectory, "workspace.json"), "utf8").catch(
    () => "",
  );
  assert.ok(raw === "" || !/objectKey/.test(payload.signal));
});
