import { NextRequest, NextResponse } from "next/server";
import { CommunityStoreError, unlockSharedMaterial, toPublicWorkspace } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "community-unlock", 30);
    const body: unknown = await request.json().catch(() => undefined);
    const materialId = body && typeof body === "object" && !Array.isArray(body) ? (body as { materialId?: unknown }).materialId : undefined;
    if (typeof materialId !== "string" || !materialId.trim()) return NextResponse.json({ error: "materialId 为必填项。" }, { status: 400 });
    const result = await unlockSharedMaterial(materialId.trim());
    return NextResponse.json({ unlocked: true, material: result.material, workspace: toPublicWorkspace(result.workspace) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof CommunityStoreError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: "资料解锁失败，请稍后重试。" }, { status: 500 });
  }
}
