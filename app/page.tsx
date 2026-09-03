import HomeClient from "./home-client";
import { getServerAiStatus } from "@/lib/ai-analysis";
import { getWorkspace, toPublicWorkspace } from "@/lib/workspace-store";
import type { PublicWorkspaceState } from "@/lib/workspace-types";

export const dynamic = "force-dynamic";

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default async function Page() {
  let initialWorkspace: PublicWorkspaceState | null = null;
  let initialWorkspaceError = "";

  try {
    initialWorkspace = toPublicWorkspace(await getWorkspace());
  } catch (error) {
    console.error("Unable to render the initial workspace", error);
    initialWorkspaceError = "无法读取本地学习工作区，请检查数据目录是否可用。";
  }

  return (
    <HomeClient
      initialWorkspace={initialWorkspace}
      initialWorkspaceError={initialWorkspaceError}
      initialToday={localDateKey()}
      initialAiStatus={getServerAiStatus()}
    />
  );
}
