import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DesktopEvent, Project, Session, Target } from "./types";
export const native = isTauri();
export async function call<T = any>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!native)
    throw new Error("请使用桌面程序运行此操作。浏览器仅用于界面预览。");
  return invoke<T>(command, args);
}
export const api = {
  metadata: () =>
    call<{
      projects: Project[];
      sessions: Session[];
      layout: { collapsed: boolean; panel: boolean; width: number } | null;
    }>("metadata"),
  saveProject: (value: Project) => call<Project>("project_save", { value }),
  updateSession: (id: string, patch: Partial<Session>) =>
    call<Session>("session_update", { id, patch }),
  newSession: (
    projectId: string,
    name: string,
    isolated: boolean,
    mode: string,
    extra: Record<string, unknown> = {},
  ) =>
    call<Session>("new_session", {
      projectId,
      name,
      isolated,
      mode,
      existing: null,
      fork: null,
      entryId: null,
      ...extra,
    }),
  request: (
    action: string,
    args: Record<string, unknown> = {},
    context: { projectId?: string; sessionId?: string; target?: Target } = {},
  ) =>
    call("request", {
      action,
      args,
      projectId: null,
      sessionId: null,
      target: null,
      ...context,
    }),
  rpc: (id: string, command: Record<string, unknown>) =>
    call("rpc", { id, command }),
  subscribe: (callback: (event: DesktopEvent) => void) =>
    native
      ? listen<DesktopEvent[]>("desktop-events", (e) =>
          e.payload.forEach(callback),
        )
      : Promise.resolve(() => {}),
};
