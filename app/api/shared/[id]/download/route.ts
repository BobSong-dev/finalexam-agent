import { NextRequest } from "next/server";
import { CommunityStoreError, createFileDownloadResponse, getSharedMaterialFileReference } from "@/lib/workspace-store";
import { assertNotCrossSite, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext<"/api/shared/[id]/download">) {
  try {
    assertNotCrossSite(request);
    enforceRateLimit(request, "community-download", 60);
    const { id } = await context.params;
    const { material, filePath, byteSize } = await getSharedMaterialFileReference(id);
    return createFileDownloadResponse(filePath, material.mimeType || "application/octet-stream", material.title, byteSize);
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    const trusted = error instanceof CommunityStoreError;
    return Response.json({ error: trusted ? error.message : "共享资料下载失败。" }, { status: trusted ? error.status : 500 });
  }
}
