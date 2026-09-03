import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { NextRequest } from "next/server";
import { AuthError, requestEmailOtp, verifyEmailOtp } from "../lib/auth-store";
import { WorkspaceStoreError, archiveExpiredSharedMaterials, beginMaterialAnalysis, createCourse, contributeSharedMaterial, getWorkspace, listCommunityMaterials, listModerationQueue, reportSharedMaterial, resetWorkspaceForTests, resolveSharedReport, saveDocumentAnalysis, storeUploadedMaterial, updateWorkspaceProfile } from "../lib/workspace-store";
import { POST as moderateRoute } from "../app/api/shared/moderate/route";
import { GET as queueRoute } from "../app/api/shared/moderation/queue/route";
import { POST as resolveRoute } from "../app/api/shared/reports/[id]/resolve/route";
import { GET as downloadSharedMaterial } from "../app/api/shared/[id]/download/route";
import type { DocumentAnalysis } from "../lib/ai-types";

const analysis: DocumentAnalysis = {
  documentTitle: "community.pdf",
  materialKind: "试卷",
  pageCount: 1,
  summary: "包含真实来源的测试分析。",
  confidence: "high",
  keyPoints: [{ id: "p1", title: "极限", importance: 4, evidence: { label: "community.pdf", location: "第 1 页", quote: "求极限" } }],
  questionPatterns: [],
  studyActions: ["完成练习"],
  generatedQuestions: [],
  warnings: [],
};

test("email verification and community moderation persist honest local state", async () => {
  const dataDir = await mkdtemp(`${tmpdir()}\\finale-community-${randomUUID()}-`);
  const old = { data: process.env.FINALE_DATA_DIR, secret: process.env.AUTH_OTP_SECRET, mail: process.env.EMAIL_PROVIDER_URL, domains: process.env.SCHOOL_EMAIL_DOMAINS, admin: process.env.COMMUNITY_ADMIN_TOKEN };
  let sentCode = "";
  let deliveryCount = 0;
  let failNextDelivery = false;
  const provider = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try { sentCode = JSON.parse(body).text.match(/\d{6}/)?.[0] ?? ""; } catch { sentCode = ""; }
      deliveryCount += 1;
      const status = failNextDelivery ? 503 : 200;
      failNextDelivery = false;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", () => resolve()); });
  const address = provider.address() as AddressInfo;
  try {
    process.env.FINALE_DATA_DIR = dataDir;
    process.env.AUTH_OTP_SECRET = "test-secret-that-is-long-enough-for-otp";
    process.env.EMAIL_PROVIDER_URL = `http://127.0.0.1:${address.port}/send`;
    process.env.SCHOOL_EMAIL_DOMAINS = "example.edu=示例大学";
    process.env.COMMUNITY_ADMIN_TOKEN = "test-admin-token";
    await resetWorkspaceForTests();
    const course = (await createCourse({ name: "高等数学", code: "MATH201", teacher: "测试老师", term: "2026 秋", examDate: "2099-12-30", priority: "高" })).course;
    const uploadedBytes = Buffer.from("%PDF-1.4 community");
    const uploaded = await storeUploadedMaterial(course.id, new File([uploadedBytes], "community.pdf", { type: "application/pdf" }));
    const analysisReservation = await beginMaterialAnalysis(uploaded.material.id);
    await saveDocumentAnalysis(uploaded.material.id, analysis, analysisReservation.runId);
    const otp = await requestEmailOtp("student@example.edu");
    assert.equal(otp.expiresInSeconds, 600);
    const invalid = await verifyEmailOtp("student@example.edu", sentCode === "000000" ? "000001" : "000000").catch((error: unknown) => error);
    assert.match(String(invalid), /验证码/);
    assert.equal((await getWorkspace()).profile.verified, false);
    assert.match(sentCode, /^\d{6}$/);

    const verified = await verifyEmailOtp("student@example.edu", sentCode);
    assert.equal(verified.schoolMatched, true);
    assert.equal(verified.workspace.profile.verified, true);

    await requestEmailOtp("locked@example.edu");
    const lockedCode = sentCode;
    const wrongLockedCode = lockedCode === "000000" ? "000001" : "000000";
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const rejected = await verifyEmailOtp("locked@example.edu", wrongLockedCode).catch((error: unknown) => error);
      assert.ok(rejected instanceof WorkspaceStoreError);
      assert.equal(rejected.status, 400);
      assert.equal(rejected.message, "验证码不正确。");
      assert.equal((await getWorkspace()).otpChallenges.find((challenge) => challenge.email === "locked@example.edu")?.attempts, attempt);
    }
    const exhausted = await verifyEmailOtp("locked@example.edu", lockedCode).catch((error: unknown) => error);
    assert.ok(exhausted instanceof WorkspaceStoreError);
    assert.equal(exhausted.status, 429);
    assert.equal(exhausted.message, "验证码尝试次数过多，请重新获取。");

    const beforeConcurrentDelivery = deliveryCount;
    const concurrent = await Promise.allSettled([
      requestEmailOtp("parallel@example.edu"),
      requestEmailOtp("parallel@example.edu"),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const duplicate = concurrent.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(duplicate?.reason instanceof AuthError);
    assert.equal(duplicate.reason.status, 429);
    assert.equal(duplicate.reason.code, "OTP_COOLDOWN");
    assert.equal(deliveryCount, beforeConcurrentDelivery + 1, "concurrent requests for one email must deliver exactly one message");

    const beforeFailedDelivery = deliveryCount;
    failNextDelivery = true;
    const failedDelivery = await requestEmailOtp("retry@example.edu").catch((error: unknown) => error);
    assert.ok(failedDelivery instanceof AuthError);
    assert.equal(failedDelivery.status, 502);
    const retriedDelivery = await requestEmailOtp("retry@example.edu");
    assert.equal(retriedDelivery.email, "retry@example.edu", "a provider failure must release the in-flight guard for immediate retry");
    assert.equal(deliveryCount, beforeFailedDelivery + 2);

    const submitted = await contributeSharedMaterial({ materialId: uploaded.material.id, consent: true, privacyConfirmed: true });
    assert.equal(submitted.material.status, "待审核");
    assert.equal((await getWorkspace()).profile.credits, 0);

    // Exercise the actual operator route. In particular, the Bearer parser
    // must strip the scheme before comparing the configured token.
    const moderationResponse = await moderateRoute(new NextRequest("http://localhost/api/shared/moderate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin-token" },
      body: JSON.stringify({ materialId: submitted.material.id, decision: "approve", quality: "已核验" }),
    }));
    assert.equal(moderationResponse.status, 200);
    const moderationPayload = await moderationResponse.json() as { material?: { status?: string }; workspace?: { profile?: { credits?: number } } };
    assert.equal(moderationPayload.material?.status, "可解锁");
    assert.equal(moderationPayload.workspace?.profile?.credits, 10);

    const missingDownload = await downloadSharedMaterial(
      new NextRequest("http://localhost/api/shared/missing/download"),
      { params: Promise.resolve({ id: "missing" }) },
    );
    assert.equal(missingDownload.status, 404);
    assert.equal((await missingDownload.json() as { error?: string }).error, "未找到共享资料。", "trusted community errors retain their public message and status");

    const sharedDownload = await downloadSharedMaterial(
      new NextRequest(`http://localhost/api/shared/${submitted.material.id}/download`),
      { params: Promise.resolve({ id: submitted.material.id }) },
    );
    assert.equal(sharedDownload.status, 200);
    assert.equal(sharedDownload.headers.get("content-type"), "application/pdf");
    assert.deepEqual(Buffer.from(await sharedDownload.arrayBuffer()), uploadedBytes, "the zero-copy response view must preserve every shared-file byte");

    const sharedRecord = (await getWorkspace()).sharedMaterialRecords.find((record) => record.id === submitted.material.id);
    assert.ok(sharedRecord);
    const sharedFilePath = path.join(dataDir, "uploads", "shared", sharedRecord.objectKey);
    const sharedBackupPath = `${sharedFilePath}.backup`;
    await rename(sharedFilePath, sharedBackupPath);
    try {
      await mkdir(sharedFilePath);
      const failedDownload = await downloadSharedMaterial(
        new NextRequest(`http://localhost/api/shared/${submitted.material.id}/download`),
        { params: Promise.resolve({ id: submitted.material.id }) },
      );
      assert.equal(failedDownload.status, 500);
      const failedPayload = await failedDownload.json() as { error?: string };
      assert.equal(failedPayload.error, "共享资料下载失败。");
      assert.doesNotMatch(JSON.stringify(failedPayload), new RegExp(sharedRecord.objectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "unknown filesystem errors must not expose storage details");
    } finally {
      await rm(sharedFilePath, { recursive: true, force: true });
      await rename(sharedBackupPath, sharedFilePath);
    }

    const catalogStatePath = path.join(dataDir, "workspace.json");
    const beforeCatalogRead = await readFile(catalogStatePath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const catalog = await listCommunityMaterials();
    assert.equal(catalog.materials.length, 1);
    assert.equal(await readFile(catalogStatePath, "utf8"), beforeCatalogRead, "a catalog read with nothing to archive must not rewrite workspace state");

    // A verified learner can report the approved material; the operator queue
    // surfaces the unresolved report and the resolve endpoint closes it.
    await reportSharedMaterial({ materialId: submitted.material.id, reason: "疑似包含答案", detail: "请复核" });
    let queue = await listModerationQueue();
    assert.equal(queue.pending.length, 0, "no pending contributions remain after approval");
    assert.equal(queue.activeCount, 1);
    assert.equal(queue.reports.length, 1);
    assert.equal(queue.reports[0]?.materialTitle, "community.pdf");

    const queueResponse = await queueRoute(new NextRequest("http://localhost/api/shared/moderation/queue"));
    assert.equal(queueResponse.status, 403, "the queue must require the admin bearer credential");
    const authorizedQueue = await queueRoute(new NextRequest("http://localhost/api/shared/moderation/queue", {
      headers: { Authorization: "Bearer test-admin-token" },
    }));
    assert.equal(authorizedQueue.status, 200);
    const queuePayload = await authorizedQueue.json() as { reports: Array<{ id: string }> };
    assert.equal(queuePayload.reports.length, 1);

    const resolveResponse = await resolveRoute(
      new NextRequest("http://localhost/api/shared/reports/unknown/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin-token" },
        body: JSON.stringify({ resolution: "已下架并通知贡献者" }),
      }),
      { params: Promise.resolve({ id: "unknown" }) },
    );
    assert.equal(resolveResponse.status, 404);

    const reportId = queuePayload.reports[0]!.id;
    const resolved = await resolveSharedReport(reportId, "已下架并通知贡献者");
    assert.ok(resolved.sharedReports.find((report) => report.id === reportId)?.resolvedAt);
    queue = await listModerationQueue();
    assert.equal(queue.reports.length, 0, "resolved reports leave the operator queue");
    await assert.rejects(
      () => resolveSharedReport(reportId, "重复处理"),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "REPORT_ALREADY_RESOLVED"),
    );

    // Editing a verified boundary must revoke the old grant until another OTP
    // verification establishes a new school scope.
    const changedProfile = await updateWorkspaceProfile({ email: "other@example.edu" });
    assert.equal(changedProfile.profile.verified, false);
    const afterBoundaryChange = await listCommunityMaterials();
    assert.equal(afterBoundaryChange.materials.length, 1);
    assert.equal(afterBoundaryChange.materials[0]?.isMine, true);

    const statePath = path.join(dataDir, "workspace.json");
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { sharedMaterialRecords: Array<{ accessEndsOn: string }> };
    persisted.sharedMaterialRecords[0]!.accessEndsOn = "2000-01-01";
    await writeFile(statePath, `${JSON.stringify(persisted)}\n`, "utf8");
    assert.equal(await archiveExpiredSharedMaterials(), 1);
    const archived = await getWorkspace();
    assert.equal(archived.sharedMaterialRecords[0]?.status, "已归档");
  } finally {
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    if (old.data === undefined) delete process.env.FINALE_DATA_DIR; else process.env.FINALE_DATA_DIR = old.data;
    if (old.secret === undefined) delete process.env.AUTH_OTP_SECRET; else process.env.AUTH_OTP_SECRET = old.secret;
    if (old.mail === undefined) delete process.env.EMAIL_PROVIDER_URL; else process.env.EMAIL_PROVIDER_URL = old.mail;
    if (old.domains === undefined) delete process.env.SCHOOL_EMAIL_DOMAINS; else process.env.SCHOOL_EMAIL_DOMAINS = old.domains;
    if (old.admin === undefined) delete process.env.COMMUNITY_ADMIN_TOKEN; else process.env.COMMUNITY_ADMIN_TOKEN = old.admin;
    await rm(dataDir, { recursive: true, force: true });
  }
});
