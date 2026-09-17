import { NextRequest, NextResponse } from "next/server";
import { WorkspaceStoreError, importWorkspaceData, toPublicWorkspace } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 导入上限：与导出文件规模匹配，避免用超大 JSON 把进程拖垮。 */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/**
 * 用导出的 JSON 覆盖当前工作区。导入是整份替换，服务端在替换前会把现有
 * workspace.json 另存为 workspace.pre-import-<时间>.json。
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "workspace-import", 5);
    const raw = request.headers.get("content-length");
    if (raw !== null) {
      const length = Number(raw);
      if (!Number.isSafeInteger(length) || length > MAX_IMPORT_BYTES) {
        return NextResponse.json({ error: "导入文件过大（上限 64 MB）。" }, { status: 413 });
      }
    }
    const body: unknown = await request.json().catch(() => undefined);
    if (body === undefined) {
      return NextResponse.json({ error: "导入内容不是有效的 JSON。" }, { status: 400 });
    }
    const payload =
      body && typeof body === "object" && !Array.isArray(body) && "workspace" in body
        ? (body as { workspace?: unknown }).workspace
        : body;
    const result = await importWorkspaceData(payload);
    return NextResponse.json(
      {
        accepted: true,
        workspace: toPublicWorkspace(result.workspace),
        notice: `已导入 ${result.courses} 门课程与 ${result.materials} 份资料；导入前的数据已备份为 ${result.backupPath.split(/[\\/]/).pop()}。`,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof WorkspaceStoreError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "工作区导入失败，现有数据未被修改。" }, { status: 500 });
  }
}
