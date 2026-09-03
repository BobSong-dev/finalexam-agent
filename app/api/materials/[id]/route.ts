import { NextRequest, NextResponse } from "next/server";
import { WorkspaceStoreError, deleteStoredMaterial, getStoredMaterial, toPublicMaterial, toPublicWorkspace } from "@/lib/workspace-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";


export async function GET(_request: NextRequest, context: RouteContext<"/api/materials/[id]">) {
  try {
    const { id } = await context.params;
    return NextResponse.json({ material: toPublicMaterial(await getStoredMaterial(id)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext<"/api/materials/[id]">) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "material-delete", 60);
    const { id } = await context.params;
    return NextResponse.json(toPublicWorkspace(await deleteStoredMaterial(id)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof WorkspaceStoreError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: "资料操作失败，请稍后重试。" }, { status: 500 });
}
