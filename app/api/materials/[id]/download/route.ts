import { NextRequest } from "next/server";
import { WorkspaceStoreError, readStoredMaterialFile, sanitizeDownloadFilename } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext<"/api/materials/[id]/download">) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "material-download", 60);
    const { id } = await context.params;
    const { material, buffer } = await readStoredMaterialFile(id);
    const body = new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
    return new Response(body, {
      headers: {
        "Content-Type": material.mimeType || "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(sanitizeDownloadFilename(material.name))}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    const status = error instanceof WorkspaceStoreError ? error.status : 500;
    const message = error instanceof WorkspaceStoreError ? error.message : "资料下载失败。";
    return Response.json({ error: message }, { status });
  }
}
