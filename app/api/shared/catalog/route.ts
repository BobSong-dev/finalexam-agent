import { NextRequest, NextResponse } from "next/server";
import { CommunityStoreError, listCommunityMaterials } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "community-catalog", 120);
    return NextResponse.json(await listCommunityMaterials(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    if (error instanceof CommunityStoreError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: "校内资料目录暂时无法读取。" }, { status: 500 });
  }
}
