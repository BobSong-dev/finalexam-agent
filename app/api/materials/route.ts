import { NextRequest, NextResponse } from "next/server";
import { WorkspaceStoreError, getWorkspace, storeUploadedMaterial, toPublicMaterial, toPublicWorkspace } from "@/lib/workspace-store";
import { assertSameOrigin, enforceRateLimit, securityErrorResponse } from "@/lib/http-security";
import { acquireHeavyRequestSlot, runtimeCapacityErrorResponse } from "@/lib/runtime-capacity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_MULTIPART_REQUEST_BYTES = 55 * 1024 * 1024;

export async function GET() {
  try {
    const workspace = await getWorkspace();
    return NextResponse.json({ materials: workspace.materials.map(toPublicMaterial) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  let releaseCapacity: (() => void) | undefined;
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, "material-upload", 30);
    assertUploadRequestSize(request);
    releaseCapacity = acquireHeavyRequestSlot();
    const formData = await parseUploadForm(request);
    const courseId = formData.get("courseId");
    const file = formData.get("file");
    if (typeof courseId !== "string" || !courseId.trim()) throw new WorkspaceStoreError("请选择要归属的课程。", 400);
    if (!(file instanceof File)) throw new WorkspaceStoreError("请从本机选择一个资料文件。", 400);
    const result = await storeUploadedMaterial(courseId.trim(), file);
    return NextResponse.json({ material: toPublicMaterial(result.material), workspace: toPublicWorkspace(result.workspace) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = securityErrorResponse(error);
    if (security) return security;
    const capacity = runtimeCapacityErrorResponse(error);
    if (capacity) return capacity;
    return errorResponse(error);
  } finally {
    releaseCapacity?.();
  }
}

function assertUploadRequestSize(request: NextRequest): void {
  const raw = request.headers.get("content-length");
  if (raw === null) throw new WorkspaceStoreError("上传请求必须声明内容长度。", 411);
  if (!/^\d+$/.test(raw.trim())) throw new WorkspaceStoreError("上传请求大小无效。", 400);
  const contentLength = Number(raw);
  if (!Number.isSafeInteger(contentLength) || contentLength > MAX_MULTIPART_REQUEST_BYTES) {
    throw new WorkspaceStoreError("上传内容超过允许的大小（50 MB）。", 413);
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;") || !contentType.includes("boundary=")) {
    throw new WorkspaceStoreError("资料上传必须使用 multipart/form-data。", 415);
  }
}

async function parseUploadForm(request: NextRequest): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new WorkspaceStoreError("上传请求的 multipart 内容无效。", 400);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof WorkspaceStoreError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: "资料保存失败，请检查数据目录权限或稍后重试。" }, { status: 500 });
}
