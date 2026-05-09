import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { EditRequest, GenerateRequest, ImageAsset, RpcNotification } from "../types";
import { WorkspaceStore } from "../storage/WorkspaceStore";
import { AppServerClient } from "./AppServerClient";

type ThreadResult = {
  thread?: {
    id?: string;
  };
};

type TurnResult = {
  turn?: {
    id?: string;
  };
};

const pendingGraceMs = 2_000;

export class TurnOrchestrator implements vscode.Disposable {
  private threadIds = new Map<string, string>();
  private activeTurnId?: string;
  private readonly consumedGeneratedPaths = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly logLine = new vscode.EventEmitter<string>();
  private readonly subscriptions: vscode.Disposable[] = [];

  readonly onDidChange = this.changed.event;
  readonly onLogLine = this.logLine.event;

  constructor(
    private readonly client: AppServerClient,
    private readonly store: WorkspaceStore,
    private readonly codexSessionsPath: string,
    private readonly generatedImagesPaths: string[],
  ) {
    this.subscriptions.push(this.client.onNotification((notification) => this.handleNotification(notification)));
  }

  get currentThreadId(): string | undefined {
    return this.threadIds.get(this.store.activeSessionId);
  }

  get currentTurnId(): string | undefined {
    return this.activeTurnId;
  }

  async generate(request: GenerateRequest): Promise<void> {
    const threadId = await this.ensureThread();
    const sessionId = this.store.activeSessionId;
    const baseId = createId("asset");
    const assets: ImageAsset[] = Array.from({ length: request.count }, (_, index) => {
      const id = request.count === 1 ? baseId : `${baseId}-${index + 1}`;
      return {
        id,
        sessionId,
        path: this.store.relativeAssetPath(`${id}.png`),
        threadId,
        prompt: request.prompt,
        createdAt: new Date().toISOString(),
        status: "generating",
      };
    });

    await this.store.upsertAssets(assets);
    await this.store.selectAsset(assets[0].id);

    const result = await this.client.request<TurnResult>("turn/start", {
      threadId,
      cwd: this.store.rootPath,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: this.writableRoots(),
        networkAccess: true,
      },
      input: [
        {
          type: "text",
          text: buildGeneratePrompt(request, assets, this.store),
        },
      ],
    });

    this.activeTurnId = result.turn?.id;
    await Promise.all(assets.map((asset) => this.store.updateAsset(asset.id, { turnId: this.activeTurnId })));
    this.changed.fire();
  }

  async edit(request: EditRequest): Promise<void> {
    await this.store.read();
    await this.store.reconcileAssetFiles();
    const source = this.store.assetById(request.assetId);
    if (!source) {
      throw new Error("Select a generated image before editing.");
    }
    if (source.status !== "ready") {
      throw new Error("Only ready images can be edited.");
    }

    const threadId = await this.ensureThread(source.threadId);
    const id = createId("asset");
    const outputAsset: ImageAsset = {
      id,
      sessionId: source.sessionId,
      path: this.store.relativeAssetPath(`${id}.png`),
      parentId: source.id,
      threadId,
      prompt: source.prompt,
      editInstruction: request.instruction,
      createdAt: new Date().toISOString(),
      sourceImageIds: [source.id],
      status: "generating",
    };

    await this.store.upsertAssets([outputAsset]);
    await this.store.selectAsset(outputAsset.id);

    const sourcePath = this.store.assetAbsolutePath(source);

    const result = await this.client.request<TurnResult>("turn/start", {
      threadId,
      cwd: this.store.rootPath,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: this.writableRoots(),
        networkAccess: true,
      },
      input: [
        {
          type: "text",
          text: buildEditPrompt(request, source, outputAsset, this.store),
        },
        {
          type: "localImage",
          path: sourcePath,
        },
      ],
    });

    this.activeTurnId = result.turn?.id;
    await this.store.updateAsset(outputAsset.id, { turnId: this.activeTurnId });
    this.changed.fire();
  }

  async retry(assetId: string): Promise<void> {
    await this.store.read();
    const asset = this.store.assetById(assetId);
    if (!asset) {
      throw new Error("Asset not found.");
    }

    if (asset.parentId && asset.editInstruction) {
      await this.edit({
        assetId: asset.parentId,
        instruction: asset.editInstruction,
        size: "auto",
        quality: "auto",
      });
      return;
    }

    await this.generate({
      prompt: asset.prompt,
      count: 1,
      size: "auto",
      quality: "auto",
    });
  }

  async interrupt(): Promise<void> {
    const threadId = this.currentThreadId;
    if (!threadId || !this.activeTurnId) {
      return;
    }
    await this.client.request("turn/interrupt", {
      threadId,
      turnId: this.activeTurnId,
    });
  }

  resetActiveSessionThread(): void {
    this.threadIds.delete(this.store.activeSessionId);
    this.activeTurnId = undefined;
    this.changed.fire();
  }

  activateSession(): void {
    this.activeTurnId = undefined;
    this.changed.fire();
  }

  private writableRoots(): string[] {
    return [this.store.rootPath, this.codexSessionsPath, ...this.generatedImagesPaths];
  }

  private async ensureThread(preferredThreadId?: string): Promise<string> {
    const sessionId = this.store.activeSessionId;
    if (preferredThreadId) {
      this.threadIds.set(sessionId, preferredThreadId);
      try {
        await this.client.request("thread/resume", {
          threadId: preferredThreadId,
          cwd: this.store.rootPath,
          personality: "friendly",
        });
        return preferredThreadId;
      } catch {
        this.threadIds.delete(sessionId);
      }
    }

    const existingThreadId = this.threadIds.get(sessionId);
    if (existingThreadId) {
      return existingThreadId;
    }

    const storedThreadId = this.store.activeSession.codexThreadId;
    if (storedThreadId) {
      try {
        await this.client.request("thread/resume", {
          threadId: storedThreadId,
          cwd: this.store.rootPath,
          personality: "friendly",
        });
        this.threadIds.set(sessionId, storedThreadId);
        return storedThreadId;
      } catch {
        await this.store.updateSession(sessionId, { codexThreadId: undefined });
      }
    }

    const model = vscode.workspace.getConfiguration("codexImageEditor").get<string>("defaultModel", "gpt-5.4");
    const result = await this.client.request<ThreadResult>("thread/start", {
      model,
      cwd: this.store.rootPath,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: this.writableRoots(),
        networkAccess: true,
      },
      personality: "friendly",
      serviceName: "vscode_codex_image_editor",
    });

    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id.");
    }

    this.threadIds.set(sessionId, threadId);
    await this.store.updateSession(sessionId, { codexThreadId: threadId });
    return threadId;
  }

  private handleNotification(notification: RpcNotification): void {
    if (notification.method === "turn/started") {
      const turn = notification.params?.turn;
      if (isRecord(turn) && typeof turn.id === "string") {
        this.activeTurnId = turn.id;
      }
      this.changed.fire();
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      const delta = notification.params?.delta;
      if (typeof delta === "string") {
        this.logLine.fire(delta);
      }
      return;
    }

    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = notification.params?.item;
      if (isRecord(item) && typeof item.type === "string") {
        this.logLine.fire(`${notification.method}: ${item.type}`);
        if (notification.method === "item/completed") {
          void this.handleGeneratedImagePaths(imageGenerationSavedPaths(item), this.extractTurnId(notification));
        }
        if (item.type === "imageView") {
          void this.selectImageViewItem(item);
        }
      }
      return;
    }

    if (notification.method === "turn/completed") {
      const completedTurnId = this.extractTurnId(notification);
      if (!completedTurnId || completedTurnId === this.activeTurnId) {
        this.activeTurnId = undefined;
      }
      this.changed.fire();
      setTimeout(() => {
        void this.reconcileCompletedTurn(completedTurnId);
      }, pendingGraceMs);
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.changed.dispose();
    this.logLine.dispose();
  }

  private async selectImageViewItem(item: Record<string, unknown>): Promise<void> {
    const pathValue = typeof item.path === "string"
      ? item.path
      : typeof item.uri === "string"
        ? item.uri
        : undefined;
    if (!pathValue) {
      return;
    }

    const manifest = await this.store.read();
    const normalizedPath = path.normalize(pathValue.startsWith("file://") ? vscode.Uri.parse(pathValue).fsPath : pathValue);
    const match = manifest.assets.find((asset) => {
      const assetPath = this.store.assetAbsolutePath(asset);
      return path.normalize(assetPath) === normalizedPath;
    });

    if (match) {
      await this.store.selectAsset(match.id);
    }
  }

  private extractTurnId(notification: RpcNotification): string | undefined {
    const params = notification.params;
    if (!params) {
      return undefined;
    }

    if (typeof params.turnId === "string") {
      return params.turnId;
    }

    const turn = params.turn;
    return isRecord(turn) && typeof turn.id === "string" ? turn.id : undefined;
  }

  private async reconcileCompletedTurn(turnId?: string): Promise<void> {
    const manifest = await this.store.read();
    const pending = manifest.assets.filter((asset) => {
      if (asset.status !== "generating") {
        return false;
      }
      return turnId ? asset.turnId === turnId : asset.sessionId === this.store.activeSessionId;
    });

    for (const asset of pending) {
      if (await this.store.assetFileExists(asset)) {
        await this.store.updateAsset(asset.id, {
          status: "ready",
          error: undefined,
        });
        continue;
      }

      if (await this.copyNewestGeneratedImageToAsset(asset, turnId)) {
        continue;
      }

      await this.store.updateAsset(asset.id, {
        status: "failed",
        error: "Codex completed the turn without saving this asset to the requested path.",
      });
    }
  }

  private async handleGeneratedImagePaths(savedPaths: string[], turnId?: string): Promise<void> {
    for (const savedPath of savedPaths) {
      await this.handleGeneratedImagePath(savedPath, turnId);
    }
  }

  private async handleGeneratedImagePath(savedPath: string, turnId?: string): Promise<void> {
    const asset = await this.nextPendingAsset(turnId);
    if (!asset) {
      this.logLine.fire(`imageGeneration completed at ${savedPath}, but no pending asset matched this turn.`);
      return;
    }

    await this.store.saveGeneratedImageToAsset(savedPath, asset);
    this.consumedGeneratedPaths.add(path.normalize(savedPath));
    if (asset.sessionId === this.store.activeSessionId) {
      await this.store.selectAsset(asset.id);
    }
  }

  private async nextPendingAsset(turnId?: string): Promise<ImageAsset | undefined> {
    const manifest = await this.store.read();
    const pending = manifest.assets
      .filter((asset) => asset.status === "generating")
      .filter((asset) => turnId
        ? asset.turnId === turnId || (!asset.turnId && asset.sessionId === this.store.activeSessionId)
        : asset.sessionId === this.store.activeSessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return pending[0];
  }

  private async copyNewestGeneratedImageToAsset(asset: ImageAsset, turnId?: string): Promise<boolean> {
    const candidates = await this.findGeneratedImages(turnId);
    for (const candidate of candidates) {
      try {
        await this.store.saveGeneratedImageToAsset(candidate, asset);
        this.consumedGeneratedPaths.add(path.normalize(candidate));
        if (asset.sessionId === this.store.activeSessionId) {
          await this.store.selectAsset(asset.id);
        }
        return true;
      } catch (error) {
        this.logLine.fire(`Unable to copy generated image ${candidate}: ${String(error)}`);
      }
    }
    return false;
  }

  private async findGeneratedImages(turnId?: string): Promise<string[]> {
    const paths: Array<{ path: string; mtimeMs: number }> = [];

    const visit = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
          continue;
        }

        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".png")) {
          continue;
        }

        const stat = await fs.stat(entryPath);
        if (this.consumedGeneratedPaths.has(path.normalize(entryPath))) {
          continue;
        }
        paths.push({ path: entryPath, mtimeMs: stat.mtimeMs });
      }
    };

    for (const generatedRoot of this.generatedImagesPaths) {
      await visit(generatedRoot);
    }
    return paths
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((candidate) => candidate.path);
  }
}

function buildGeneratePrompt(request: GenerateRequest, assets: ImageAsset[], store: WorkspaceStore): string {
  const assetList = assets.map((asset) => `- ${asset.id}: ${path.join(store.rootPath, asset.path)}`).join("\n");
  return [
    "You are running inside Codex Image Studio, a VS Code extension.",
    "Use only the built-in Codex image generation capability. Return imageGeneration items with savedPath when possible.",
    "Do not run shell commands, inspect schemas, inspect session logs, search files, or edit workspace files.",
    "Do not update manifest.json. The VS Code extension will copy generated files and update the manifest.",
    "Do not call OpenAI REST APIs directly.",
    "Do not read, print, copy, or use auth.json, config.toml, access tokens, refresh tokens, API keys, or credentials.",
    `Generate ${assets.length} image candidate(s) for this prompt: ${request.prompt}`,
    `Requested size: ${request.size}. Requested quality: ${request.quality}.`,
    "The extension will assign generated images to these asset ids and paths:",
    assetList,
    "Generate the images only; do not perform any file management after generation.",
  ].join("\n\n");
}

function buildEditPrompt(request: EditRequest, source: ImageAsset, outputAsset: ImageAsset, store: WorkspaceStore): string {
  return [
    "You are running inside Codex Image Studio, a VS Code extension.",
    "Use only the built-in Codex image editing capability. Return an imageGeneration item with savedPath when possible.",
    "Do not run shell commands, inspect schemas, inspect session logs, search files, or edit workspace files.",
    "Do not update manifest.json. The VS Code extension will copy the generated file and update the manifest.",
    "Do not call OpenAI REST APIs directly.",
    "Do not read, print, copy, or use auth.json, config.toml, access tokens, refresh tokens, API keys, or credentials.",
    "Use the attached local image as the source for an iterative image edit.",
    `Source asset id: ${source.id}`,
    `Output asset id: ${outputAsset.id}`,
    `Edit instruction: ${request.instruction}`,
    `Requested size: ${request.size}. Requested quality: ${request.quality}.`,
    `The extension will copy the edited PNG to: ${path.join(store.rootPath, outputAsset.path)}`,
    "Generate the edited image only; do not perform any file management after generation.",
  ].join("\n\n");
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function imageGenerationSavedPaths(item: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  collectImageGenerationPaths(item, paths);
  return Array.from(paths);
}

function collectImageGenerationPaths(value: unknown, paths: Set<string>): void {
  if (!isRecord(value)) {
    return;
  }

  if (value.type === "imageGeneration") {
    addImageGenerationPath(value, paths);
  }

  collectImageGenerationPayload(value.imageGeneration, paths);
  collectImageGenerationPayload(value.imageGenerations, paths);
}

function collectImageGenerationPayload(value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectImageGenerationPayload(item, paths);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  addImageGenerationPath(value, paths);
  collectImageGenerationPaths(value, paths);
}

function addImageGenerationPath(value: Record<string, unknown>, paths: Set<string>): void {
  const savedPath = typeof value.savedPath === "string"
    ? value.savedPath
    : typeof value.path === "string"
      ? value.path
      : undefined;
  if (savedPath) {
    paths.add(savedPath);
  }
}
