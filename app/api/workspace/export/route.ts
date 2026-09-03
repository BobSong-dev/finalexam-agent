import { NextRequest } from "next/server";
import { WorkspaceStoreError, exportWorkspaceData } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The workspace owner's own backup snapshot. This deliberately includes the
 * server-side storage metadata (object keys, hashes) so a restore can be
 * performed against a fresh data directory; the same fields are still never
 * returned by the normal /api/workspace response.
 */
export async function GET(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "workspace-export", 10);
    const workspace = await exportWorkspaceData();
    const date = new Date().toISOString().slice(0, 10);
    const body = new TextEncoder().encode(`${JSON.stringify(workspace, null, 2)}\n`);
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`finale-workspace-export-${date}.json`)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    const status = error instanceof WorkspaceStoreError ? error.status : 500;
    return Response.json({ error: error instanceof WorkspaceStoreError ? error.message : "工作区导出失败。" }, { status });
  }
}
