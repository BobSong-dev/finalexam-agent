import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  WorkspaceStoreError,
  createCourse,
  rebuildPlan,
  rescheduleMissedTasks,
} from "../lib/workspace-store";
import { POST as rescheduleRoute } from "../app/api/plan/missed/route";

const temporaryDataDirectory = path.join(
  os.tmpdir(),
  `finale-missed-${process.pid}-${randomUUID()}`,
);
const previousDataDirectory = process.env.FINALE_DATA_DIR;
process.env.FINALE_DATA_DIR = temporaryDataDirectory;

test.after(async () => {
  if (previousDataDirectory === undefined) delete process.env.FINALE_DATA_DIR;
  else process.env.FINALE_DATA_DIR = previousDataDirectory;
  await rm(temporaryDataDirectory, { recursive: true, force: true });
});

test("missed tasks can be pulled back into the plan as due reviews", async () => {
  const { course } = await createCourse({
    name: "补做课程",
    code: "MISS-1",
    teacher: "t",
    term: "2026 秋",
    examDate: "2099-12-30",
    priority: "高",
  });

  // 直接写入一条「过去的」未完成任务，模拟用户几天没打开应用。
  const statePath = path.join(temporaryDataDirectory, "workspace.json");
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
    tasks: Array<Record<string, unknown>>;
  };
  persisted.tasks.push({
    id: "missed-reschedule-test",
    courseId: course.id,
    date: "2000-01-01",
    start: "18:30",
    duration: 45,
    title: "被错过的复习任务",
    type: "复习",
    status: "待完成",
    reason: "测试旧任务",
    knowledge: "极限的计算",
  });
  await writeFile(statePath, JSON.stringify(persisted), "utf8");

  const rolled = await rebuildPlan();
  assert.ok(
    rolled.missedTasks.some((task) => task.id === "missed-reschedule-test"),
    "past uncompleted tasks become missed records",
  );

  const result = await rescheduleMissedTasks();
  assert.equal(result.rescheduled, 1);
  assert.equal(result.workspace.missedTasks.length, 0, "rescheduled tasks leave the missed list");
  assert.ok(result.workspace.auditLog.some((event) => event.action === "plan.missed_rescheduled"));
  assert.ok(result.workspace.tasks.length > 0, "the plan is rebuilt after rescheduling");
  // 补做的知识点以「今天到期」进入排期，因此会变成到期复习任务。
  assert.ok(
    result.workspace.tasks.some((task) => task.courseId === course.id),
    "the course still has scheduled work",
  );

  const dueRecord = result.workspace.tasks.find((task) => task.reviewKind === "due");
  assert.ok(dueRecord, "the rescheduled item is scheduled as a due review");
  assert.match(dueRecord.title, /间隔复习|重练错题/);

  await assert.rejects(
    () => rescheduleMissedTasks(),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 400,
    "rescheduling with an empty missed list is rejected",
  );
});

test("the reschedule route validates its body and rejects cross-origin calls", async () => {
  await createCourse({
    name: "补做路由课程",
    code: "MISS-2",
    teacher: "t",
    term: "2026 秋",
    examDate: "2099-12-30",
    priority: "中",
  });

  const blocked = await rescheduleRoute(
    new NextRequest("http://localhost/api/plan/missed", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: "{}",
    }),
  );
  assert.equal(blocked.status, 403);

  const badBody = await rescheduleRoute(
    new NextRequest("http://localhost/api/plan/missed", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ taskIds: "not-an-array" }),
    }),
  );
  assert.equal(badBody.status, 400);

  const noneMissed = await rescheduleRoute(
    new NextRequest("http://localhost/api/plan/missed", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: "{}",
    }),
  );
  assert.equal(noneMissed.status, 400, "nothing missed yet");
});
