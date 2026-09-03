import { NextResponse } from "next/server";
import { getServerAiStatus } from "@/lib/ai-analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getServerAiStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
