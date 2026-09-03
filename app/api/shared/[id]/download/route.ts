import { NextRequest } from "next/server";
import { CommunityStoreError, readSharedMaterialFile, sanitizeDownloadFilename } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext<"/api/shared/[id]/download">) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "community-download", 60);
    const { id } = await context.params;
    const { material, buffer } = await readSharedMaterialFile(id);
    const body = new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
    return new Response(body, {
      headers: {
        "Content-Type": material.mimeType || "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(sanitizeDownloadFilename(material.title))}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    const trusted = error instanceof CommunityStoreError;
    return Response.json({ error: trusted ? error.message : "共享资料下载失败。" }, { status: trusted ? error.status : 500 });
  }
}
