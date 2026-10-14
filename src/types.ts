export type Target = {
  kind: "windows" | "wsl";
  distro?: string;
  user?: string;
  node?: string;
  pi?: string;
};
export type Project = {
  id: string;
  name: string;
  path: string;
  target: Target;
  trusted: boolean;
};
export type Session = {
  id: string;
  projectId: string;
  name: string;
  cwd: string;
  file: string;
  mode: "plan" | "execute";
  worktree: boolean;
  branch: string;
  pinned: boolean;
  archived: boolean;
  updated: number;
  runtimeState?: string;
};
export type RuntimeInfo = {
  target: Target;
  node?: string;
  nodeVersion?: string;
  pi?: string;
  version?: string;
  git?: string;
  home?: string;
  agentDir?: string;
  error?: string;
  ready: boolean;
};
export type DesktopEvent = {
  sessionId: string;
  sequence: number;
  kind: string;
  payload: any;
};
export type PiMessage = {
  role: string;
  content: any;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  usage?: any;
  errorMessage?: string;
  stopReason?: string;
};
