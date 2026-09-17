import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  WorkspaceStoreError,
  createCourse,
  exportWorkspaceData,
  getWorkspace,
  importWorkspaceData,
  storeUploadedMaterial,
} from "../lib/workspace-store";
import { POST as importRoute } from "../app/api/workspace/import/route";

const temporaryDataDirectory = path.join(
  os.tmpdir(),
  `finale-import-${process.pid}-${randomUUID()}`,
);
const previousDataDirectory = process.env.FINALE_DATA_DIR;
process.env.FINALE_DATA_DIR = temporaryDataDirectory;

test.after(async () => {
  if (previousDataDirectory === undefined) delete process.env.FINALE_DATA_DIR;
  else process.env.FINALE_DATA_DIR = previousDataDirectory;
  await rm(temporaryDataDirectory, { recursive: true, force: true });
});

test("importing a backup replaces the workspace and keeps a pre-import copy", async () => {
  const { course } = await createCourse({
    name: "导入源课程",
    code: "IMP-1",
    teacher: "t",
    term: "2026 秋",
    examDate: "2099-12-30",
    priority: "高",
  });
  await storeUploadedMaterial(
    course.id,
    new File([Buffer.from("%PDF-1.4\n")], "备份资料.pdf", { type: "application/pdf" }),
  );
  const exported = await exportWorkspaceData();
  assert.equal(exported.courses.length, 1);

  // 改动当前工作区，再导入备份，确认回到备份时的状态。
  const { course: extra } = await createCourse({
    name: "临时课程",
    code: "IMP-2",
    teacher: "t",
    term: "2026 秋",
    examDate: "2099-12-30",
    priority: "中",
  });
  assert.equal((await getWorkspace()).courses.length, 2);

  const result = await importWorkspaceData(exported);
  assert.equal(result.courses, 1);
  assert.equal(result.materials, 1);
  const restored = await getWorkspace();
  assert.equal(restored.courses.length, 1);
  assert.equal(restored.courses[0]!.id, course.id);
  assert.equal(
    restored.courses.some((item) => item.id === extra.id),
    false,
  );
  assert.equal(restored.materials.length, 1);
  assert.ok(restored.auditLog.some((event) => event.action === "workspace.imported"));

  const files = await readdir(temporaryDataDirectory);
  assert.equal(
    files.filter((name) => name.startsWith("workspace.pre-import-")).length,
    1,
    "a pre-import backup is written",
  );
  const backup = JSON.parse(
    await readFile(
      path.join(
        temporaryDataDirectory,
        files.find((name) => name.startsWith("workspace.pre-import-"))!,
      ),
      "utf8",
    ),
  ) as { courses: unknown[] };
  assert.equal(backup.courses.length, 2, "the backup captures the state before the import");
});

test("an invalid backup is rejected without touching existing data", async () => {
  const before = await getWorkspace();
  await assert.rejects(
    () => importWorkspaceData({ version: 2, courses: "not-an-array" }),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 400,
  );
  await assert.rejects(
    () => importWorkspaceData("plain text"),
    (error: unknown) => error instanceof WorkspaceStoreError && error.status === 400,
  );
  const after = await getWorkspace();
  assert.equal(after.courses.length, before.courses.length);
  assert.equal(after.updatedAt, before.updatedAt, "a rejected import must not write the workspace");
});

test("the import route accepts both a bare snapshot and a wrapped payload", async () => {
  const exported = await exportWorkspaceData();
  const wrapped = await importRoute(
    new NextRequest("http://localhost/api/workspace/import", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ workspace: exported }),
    }),
  );
  assert.equal(wrapped.status, 200);
  const payload = (await wrapped.json()) as { workspace?: unknown; notice?: string };
  assert.ok(payload.workspace);
  assert.match(payload.notice ?? "", /已导入/);
  assert.equal(
    JSON.stringify(payload).includes("objectKey"),
    false,
    "import response is the public projection",
  );

  const rejected = await importRoute(
    new NextRequest("http://localhost/api/workspace/import", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ nope: true }),
    }),
  );
  assert.equal(rejected.status, 400);
});
