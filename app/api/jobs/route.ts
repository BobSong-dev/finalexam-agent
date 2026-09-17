import { NextRequest, NextResponse } from "next/server";
import { getProcessingSnapshot } from "@/lib/workspace-store";
import { enforceRateLimit, securityErrorResponse } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 轮询用的轻量端点：只返回后台任务阶段、失败记录和一个内容相关的 signal。
 * 前端在 signal 变化时才重新拉取整份工作区，避免每 2 秒下载全部分析与题目。
 */
export async function GET(request: NextRequest) {
  try {
    enforceRateLimit(request, "jobs-read", 300);
    return NextResponse.json(await getProcessingSnapshot(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    return NextResponse.json({ error: "后台任务状态暂时无法读取。" }, { status: 500 });
  }
}
