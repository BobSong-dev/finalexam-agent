import { NextRequest } from "next/server";
import { WorkspaceStoreError, createFileDownloadResponse, getStoredMaterialFileReference } from "@/lib/workspace-store";
import { assertNotCrossSite, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext<"/api/materials/[id]/download">) {
  try {
    assertNotCrossSite(request);
    enforceRateLimit(request, "material-download", 60);
    const { id } = await context.params;
    const { material, filePath, byteSize } = await getStoredMaterialFileReference(id);
    return createFileDownloadResponse(filePath, material.mimeType || "application/octet-stream", material.name, byteSize);
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    const status = error instanceof WorkspaceStoreError ? error.status : 500;
    const message = error instanceof WorkspaceStoreError ? error.message : "资料下载失败。";
    return Response.json({ error: message }, { status });
  }
}
