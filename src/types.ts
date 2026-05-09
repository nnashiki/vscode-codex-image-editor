import type * as vscode from "vscode";

export type JsonObject = Record<string, unknown>;

export type RpcRequest = {
  id: number;
  method: string;
  params?: JsonObject;
};

export type RpcResponse = {
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message: string;
    data?: unknown;
  };
};

export type RpcNotification = {
  method: string;
  params?: JsonObject;
};

export type RpcMessage = RpcResponse | RpcNotification;

export type AuthState = {
  authMode: "apikey" | "chatgpt" | "chatgptAuthTokens" | null;
  planType: string | null;
  email?: string;
  requiresOpenaiAuth?: boolean;
  rateLimits?: RateLimits | null;
};

export type RateLimits = {
  limitId?: string;
  limitName?: string | null;
  primary?: {
    usedPercent?: number;
    windowDurationMins?: number;
    resetsAt?: number;
  };
  secondary?: unknown;
  rateLimitReachedType?: string | null;
};

export type ImageStatus = "generating" | "ready" | "failed";

export type ImageAsset = {
  id: string;
  sessionId: string;
  path: string;
  thumbnailPath?: string;
  parentId?: string;
  threadId: string;
  turnId?: string;
  prompt: string;
  editInstruction?: string;
  createdAt: string;
  sourceImageIds?: string[];
  status: ImageStatus;
  error?: string;
};

export type ImageSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  codexThreadId?: string;
};

export type Manifest = {
  version: 1;
  sessions: ImageSession[];
  activeSessionId: string;
  assets: ImageAsset[];
  selectedAssetId?: string;
};

export type GenerateRequest = {
  prompt: string;
  count: number;
  size: string;
  quality: string;
};

export type EditRequest = {
  assetId: string;
  instruction: string;
  size: string;
  quality: string;
};

export type WebviewState = {
  auth: AuthState;
  manifest: Manifest;
  workspaceName: string;
  activeTurnId?: string;
  log: string[];
};

export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "login" }
  | { type: "logout" }
  | { type: "refresh" }
  | { type: "newSession" }
  | { type: "switchSession"; sessionId: string }
  | { type: "generate"; request: GenerateRequest }
  | { type: "edit"; request: EditRequest }
  | { type: "select"; assetId: string }
  | { type: "retry"; assetId: string }
  | { type: "interrupt" }
  | { type: "reveal"; assetId: string };

export type ExtensionToWebviewMessage =
  | { type: "state"; state: WebviewState }
  | { type: "appendLog"; line: string }
  | { type: "error"; message: string };

export type WorkspaceContext = {
  folder: vscode.WorkspaceFolder;
  rootUri: vscode.Uri;
  studioUri: vscode.Uri;
  imagesUri: vscode.Uri;
  masksUri: vscode.Uri;
  sessionsUri: vscode.Uri;
  manifestUri: vscode.Uri;
};
