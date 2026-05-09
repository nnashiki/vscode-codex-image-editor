import * as path from "node:path";
import * as vscode from "vscode";
import type { ImageAsset, ImageSession, Manifest, WorkspaceContext } from "../types";

const defaultSessionId = "default";
const imagePathRoot = path.join(".codex-image-studio", "images");

const emptyManifest = (): Manifest => ({
  version: 1,
  sessions: [
    {
      id: defaultSessionId,
      name: "Session 1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  activeSessionId: defaultSessionId,
  assets: [],
});

export class WorkspaceStore implements vscode.Disposable {
  private manifest: Manifest = emptyManifest();
  private watcher?: vscode.FileSystemWatcher;
  private readonly changed = new vscode.EventEmitter<Manifest>();

  readonly onDidChange = this.changed.event;

  constructor(private readonly context: WorkspaceContext) {}

  static fromActiveWorkspace(): WorkspaceStore {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error("Open a workspace folder before using Codex Image Studio.");
    }

    const studioUri = vscode.Uri.joinPath(folder.uri, ".codex-image-studio");
    return new WorkspaceStore({
      folder,
      rootUri: folder.uri,
      studioUri,
      imagesUri: vscode.Uri.joinPath(studioUri, "images"),
      masksUri: vscode.Uri.joinPath(studioUri, "masks"),
      sessionsUri: vscode.Uri.joinPath(studioUri, "sessions"),
      manifestUri: vscode.Uri.joinPath(studioUri, "manifest.json"),
    });
  }

  get workspaceName(): string {
    return this.context.folder.name;
  }

  get rootPath(): string {
    return this.context.rootUri.fsPath;
  }

  get studioPath(): string {
    return this.context.studioUri.fsPath;
  }

  get imagesPath(): string {
    return this.context.imagesUri.fsPath;
  }

  get manifestPath(): string {
    return this.context.manifestUri.fsPath;
  }

  get current(): Manifest {
    return this.manifest;
  }

  get activeSessionId(): string {
    return this.manifest.activeSessionId;
  }

  get activeSession(): ImageSession {
    return this.manifest.sessions.find((session) => session.id === this.manifest.activeSessionId)
      ?? this.manifest.sessions[0];
  }

  async initialize(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.context.imagesUri);
    await vscode.workspace.fs.createDirectory(this.context.masksUri);
    await vscode.workspace.fs.createDirectory(this.context.sessionsUri);
    await this.read();
    this.watch();
  }

  async read(): Promise<Manifest> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.context.manifestUri);
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Manifest;
      this.manifest = sanitizeManifest(parsed);
    } catch {
      this.manifest = emptyManifest();
      await this.write(this.manifest);
    }

    this.changed.fire(this.manifest);
    return this.manifest;
  }

  async write(manifest: Manifest): Promise<void> {
    this.manifest = sanitizeManifest(manifest);
    const encoded = Buffer.from(`${JSON.stringify(this.manifest, null, 2)}\n`, "utf8");
    await vscode.workspace.fs.writeFile(this.context.manifestUri, encoded);
    this.changed.fire(this.manifest);
  }

  async upsertAssets(assets: ImageAsset[]): Promise<void> {
    const byId = new Map(this.manifest.assets.map((asset) => [asset.id, asset]));
    for (const asset of assets) {
      byId.set(asset.id, { ...byId.get(asset.id), ...asset });
    }
    await this.write({ ...this.manifest, assets: Array.from(byId.values()) });
  }

  async updateAsset(id: string, patch: Partial<ImageAsset>): Promise<void> {
    await this.write({
      ...this.manifest,
      assets: this.manifest.assets.map((asset) => (asset.id === id ? { ...asset, ...patch } : asset)),
    });
  }

  async saveGeneratedImageToAsset(sourcePath: string, asset: ImageAsset): Promise<void> {
    const sourceUri = sourcePath.startsWith("file://") ? vscode.Uri.parse(sourcePath) : vscode.Uri.file(sourcePath);
    const targetUri = this.assetUri(asset);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetUri.fsPath)));
    await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite: true });
    await this.updateAsset(asset.id, {
      status: "ready",
      error: undefined,
    });
  }

  async selectAsset(assetId: string): Promise<void> {
    await this.write({ ...this.manifest, selectedAssetId: assetId });
  }

  async createSession(name?: string): Promise<ImageSession> {
    const now = new Date().toISOString();
    const session: ImageSession = {
      id: createId("session"),
      name: name ?? `Session ${this.manifest.sessions.length + 1}`,
      createdAt: now,
      updatedAt: now,
    };

    await this.write({
      ...this.manifest,
      sessions: [...this.manifest.sessions, session],
      activeSessionId: session.id,
      selectedAssetId: undefined,
    });
    return session;
  }

  async switchSession(sessionId: string): Promise<void> {
    if (!this.manifest.sessions.some((session) => session.id === sessionId)) {
      throw new Error("Session not found.");
    }

    const selectedAssetId = this.latestAssetForSession(sessionId)?.id;
    await this.write({
      ...this.manifest,
      activeSessionId: sessionId,
      selectedAssetId,
    });
  }

  async updateSession(sessionId: string, patch: Partial<ImageSession>): Promise<void> {
    await this.write({
      ...this.manifest,
      sessions: this.manifest.sessions.map((session) => (
        session.id === sessionId ? { ...session, ...patch, updatedAt: new Date().toISOString() } : session
      )),
    });
  }

  activeSessionAssets(): ImageAsset[] {
    return this.manifest.assets.filter((asset) => asset.sessionId === this.manifest.activeSessionId);
  }

  private latestAssetForSession(sessionId: string): ImageAsset | undefined {
    return this.manifest.assets
      .filter((asset) => asset.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  async reconcileAssetFiles(): Promise<void> {
    const assets: ImageAsset[] = [];
    for (const asset of this.manifest.assets) {
      if ((asset.status === "generating" || asset.status === "failed") && await this.assetFileExists(asset)) {
        assets.push({ ...asset, status: "ready", error: undefined });
      } else {
        assets.push(asset);
      }
    }

    await this.write({ ...this.manifest, assets });
  }

  assetById(assetId: string): ImageAsset | undefined {
    return this.manifest.assets.find((asset) => asset.id === assetId);
  }

  async assetFileExists(asset: ImageAsset): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(this.assetUri(asset));
      return stat.type === vscode.FileType.File && stat.size > 0;
    } catch {
      return false;
    }
  }

  assetAbsolutePath(asset: ImageAsset): string {
    return this.assetUri(asset).fsPath;
  }

  asWebviewUri(webview: vscode.Webview, filePath: string): string {
    const safePath = sanitizeAssetPath(filePath);
    if (!safePath) {
      throw new Error("Invalid image asset path.");
    }

    const uri = vscode.Uri.joinPath(this.context.rootUri, safePath);
    return webview.asWebviewUri(uri).toString();
  }

  relativeAssetPath(fileName: string): string {
    return path.join(imagePathRoot, fileName);
  }

  private assetUri(asset: ImageAsset): vscode.Uri {
    const safePath = sanitizeAssetPath(asset.path);
    if (!safePath) {
      throw new Error(`Invalid image asset path for ${asset.id}.`);
    }

    return vscode.Uri.joinPath(this.context.rootUri, safePath);
  }

  private watch(): void {
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.context.folder, ".codex-image-studio/manifest.json"),
    );
    const reload = () => {
      void this.read();
    };
    this.watcher.onDidCreate(reload);
    this.watcher.onDidChange(reload);
    this.watcher.onDidDelete(async () => {
      this.manifest = emptyManifest();
      await this.write(this.manifest);
    });
  }

  dispose(): void {
    this.watcher?.dispose();
    this.changed.dispose();
  }
}

function sanitizeManifest(value: Manifest): Manifest {
  if (!value || value.version !== 1 || !Array.isArray(value.assets)) {
    return emptyManifest();
  }

  const now = new Date().toISOString();
  const parsedSessions = Array.isArray(value.sessions) ? value.sessions.filter(isImageSession) : [];
  const sessions = parsedSessions.length
    ? parsedSessions
    : [{
      id: defaultSessionId,
      name: "Session 1",
      createdAt: now,
      updatedAt: now,
    }];

  const activeSessionId = typeof value.activeSessionId === "string"
    && sessions.some((session) => session.id === value.activeSessionId)
    ? value.activeSessionId
    : sessions[0].id;

  const assets = value.assets
    .map((asset) => sanitizeImageAsset(asset, activeSessionId))
    .filter(isImageAsset);

  const selectedAssetId = typeof value.selectedAssetId === "string"
    && assets.some((asset) => asset.id === value.selectedAssetId && asset.sessionId === activeSessionId)
    ? value.selectedAssetId
    : assets
      .filter((asset) => asset.sessionId === activeSessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;

  return {
    version: 1,
    sessions,
    activeSessionId,
    selectedAssetId,
    assets,
  };
}

function isImageSession(value: unknown): value is ImageSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const session = value as Partial<ImageSession>;
  return (
    typeof session.id === "string" &&
    typeof session.name === "string" &&
    typeof session.createdAt === "string" &&
    typeof session.updatedAt === "string"
  );
}

function isImageAsset(value: unknown): value is ImageAsset {
  if (!value || typeof value !== "object") {
    return false;
  }

  const asset = value as Partial<ImageAsset>;
  return (
    typeof asset.id === "string" &&
    typeof asset.sessionId === "string" &&
    typeof asset.path === "string" &&
    typeof asset.threadId === "string" &&
    typeof asset.prompt === "string" &&
    typeof asset.createdAt === "string" &&
    (asset.status === "generating" || asset.status === "ready" || asset.status === "failed")
  );
}

function sanitizeImageAsset(value: unknown, fallbackSessionId: string): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const asset = value as Partial<ImageAsset>;
  const safePath = sanitizeAssetPath(asset.path);
  if (!safePath) {
    return undefined;
  }

  const safeThumbnailPath = asset.thumbnailPath ? sanitizeAssetPath(asset.thumbnailPath) : undefined;
  return {
    ...asset,
    sessionId: typeof asset.sessionId === "string" ? asset.sessionId : fallbackSessionId,
    path: safePath,
    thumbnailPath: safeThumbnailPath,
  };
}

function sanitizeAssetPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    return undefined;
  }

  const normalized = path.normalize(value);
  if (normalized === "." || normalized.startsWith(`..${path.sep}`) || normalized === ".." || path.isAbsolute(normalized)) {
    return undefined;
  }

  const relativeToImages = path.relative(imagePathRoot, normalized);
  if (
    !relativeToImages ||
    relativeToImages.startsWith(`..${path.sep}`) ||
    relativeToImages === ".." ||
    path.isAbsolute(relativeToImages)
  ) {
    return undefined;
  }

  return path.extname(normalized).toLowerCase() === ".png" ? normalized : undefined;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
