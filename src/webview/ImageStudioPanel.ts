import * as path from "node:path";
import * as vscode from "vscode";
import type {
  AuthState,
  ExtensionToWebviewMessage,
  ImageAsset,
  Manifest,
  WebviewState,
  WebviewToExtensionMessage,
} from "../types";
import { WorkspaceStore } from "../storage/WorkspaceStore";

type PanelHandlers = {
  login: () => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  newSession: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  generate: (prompt: string, count: number, size: string, quality: string) => Promise<void>;
  edit: (assetId: string, instruction: string, size: string, quality: string) => Promise<void>;
  select: (assetId: string) => Promise<void>;
  retry: (assetId: string) => Promise<void>;
  interrupt: () => Promise<void>;
  reveal: (assetId: string) => Promise<void>;
};

export class ImageStudioPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state: WebviewState;
  private readonly log: string[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: WorkspaceStore,
    private readonly handlers: PanelHandlers,
    initialAuth: AuthState,
  ) {
    this.state = {
      auth: initialAuth,
      manifest: store.current,
      workspaceName: store.workspaceName,
      log: this.log,
    };
  }

  reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.postState();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "codexImageStudio",
      "Codex Image Studio",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          this.extensionUri,
          vscode.Uri.file(this.store.studioPath),
        ],
      },
    );

    this.panel.webview.html = this.renderHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      void this.handleMessage(message);
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  updateAuth(auth: AuthState): void {
    this.state = { ...this.state, auth };
    this.postState();
  }

  updateManifest(manifest: Manifest): void {
    this.state = { ...this.state, manifest };
    this.postState();
  }

  updateActiveTurn(activeTurnId?: string): void {
    this.state = { ...this.state, activeTurnId };
    this.postState();
  }

  appendLog(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    this.log.push(trimmed);
    if (this.log.length > 200) {
      this.log.shift();
    }
    this.state = { ...this.state, log: [...this.log] };
    this.post({ type: "appendLog", line: trimmed });
    this.postState();
  }

  showError(message: string): void {
    this.post({ type: "error", message });
    void vscode.window.showErrorMessage(message);
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          this.postState();
          break;
        case "login":
          await this.handlers.login();
          break;
        case "logout":
          await this.handlers.logout();
          break;
        case "refresh":
          await this.handlers.refresh();
          break;
        case "newSession":
          await this.handlers.newSession();
          break;
        case "switchSession":
          await this.handlers.switchSession(message.sessionId);
          break;
        case "generate":
          await this.handlers.generate(
            message.request.prompt,
            message.request.count,
            message.request.size,
            message.request.quality,
          );
          break;
        case "edit":
          await this.handlers.edit(
            message.request.assetId,
            message.request.instruction,
            message.request.size,
            message.request.quality,
          );
          break;
        case "select":
          await this.handlers.select(message.assetId);
          break;
        case "retry":
          await this.handlers.retry(message.assetId);
          break;
        case "interrupt":
          await this.handlers.interrupt();
          break;
        case "reveal":
          await this.handlers.reveal(message.assetId);
          break;
      }
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  private postState(): void {
    this.post({ type: "state", state: this.webviewState() });
  }

  private post(message: ExtensionToWebviewMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  private webviewState(): WebviewState {
    if (!this.panel) {
      return this.state;
    }

    const assets = this.state.manifest.assets.map((asset) => this.assetForWebview(this.panel!.webview, asset));
    return {
      ...this.state,
      manifest: {
        ...this.state.manifest,
        assets,
      },
    };
  }

  private assetForWebview(webview: vscode.Webview, asset: ImageAsset): ImageAsset {
    if (asset.status !== "ready") {
      return asset;
    }

    return {
      ...asset,
      path: this.store.asWebviewUri(webview, asset.path),
      thumbnailPath: asset.thumbnailPath ? this.store.asWebviewUri(webview, asset.thumbnailPath) : undefined,
    };
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Codex Image Studio</title>
  <style>
    :root {
      color-scheme: light dark;
      --gap: 12px;
      --border: var(--vscode-panel-border, rgba(127,127,127,.35));
      --muted: var(--vscode-descriptionForeground);
      --bg-soft: var(--vscode-sideBar-background);
      --accent: var(--vscode-button-background);
      --accent-fg: var(--vscode-button-foreground);
      --danger: var(--vscode-errorForeground);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font: var(--vscode-font-size) / 1.45 var(--vscode-font-family);
    }
    button, input, select, textarea {
      font: inherit;
    }
    button {
      border: 0;
      border-radius: 4px;
      padding: 7px 10px;
      color: var(--accent-fg);
      background: var(--accent);
      cursor: pointer;
      white-space: nowrap;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.icon {
      min-width: 32px;
      padding: 7px;
    }
    button:disabled {
      opacity: .55;
      cursor: not-allowed;
    }
    input, select, textarea {
      width: 100%;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      padding: 8px;
    }
    textarea {
      min-height: 88px;
      resize: vertical;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(240px, 300px) minmax(320px, 1fr) minmax(260px, 340px);
      min-height: 100vh;
    }
    .pane {
      min-width: 0;
      padding: 14px;
      border-right: 1px solid var(--border);
    }
    .pane:last-child {
      border-right: 0;
    }
    .stack { display: grid; gap: var(--gap); }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .between { justify-content: space-between; }
    .status {
      display: grid;
      gap: 4px;
      padding: 10px;
      background: var(--bg-soft);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .status strong { font-size: 13px; }
    .status span, .hint, .meta { color: var(--muted); }
    .controls {
      display: grid;
      gap: 10px;
    }
    .control-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .gallery {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 12px;
      align-content: start;
    }
    .asset-card {
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg-soft);
      cursor: pointer;
    }
    .asset-card.selected {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .thumb {
      display: grid;
      place-items: center;
      width: 100%;
      aspect-ratio: 1 / 1;
      background: var(--vscode-editor-background);
      color: var(--muted);
      overflow: hidden;
    }
    .thumb img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .asset-info {
      display: grid;
      gap: 4px;
      padding: 8px;
      min-height: 76px;
    }
    .asset-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    .badge {
      display: inline-flex;
      width: fit-content;
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 11px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
    }
    .badge.failed {
      color: var(--danger);
      background: transparent;
      border: 1px solid currentColor;
    }
    .preview {
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .preview-box {
      display: grid;
      place-items: center;
      aspect-ratio: 1 / 1;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-soft);
      overflow: hidden;
    }
    .preview-box img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
    .log {
      max-height: 180px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      color: var(--muted);
      background: var(--bg-soft);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      white-space: pre-wrap;
    }
    .empty {
      display: grid;
      place-items: center;
      min-height: 220px;
      color: var(--muted);
      border: 1px dashed var(--border);
      border-radius: 6px;
      text-align: center;
      padding: 24px;
    }
    @media (max-width: 1000px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .pane {
        border-right: 0;
        border-bottom: 1px solid var(--border);
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="pane stack">
      <div class="row between">
        <strong>Codex Image Studio</strong>
        <button class="icon secondary" id="refresh" title="Refresh">↻</button>
      </div>
      <section class="status" id="sessions"></section>
      <section class="status" id="auth"></section>
      <section class="controls">
        <label>Prompt
          <textarea id="prompt" placeholder="Describe the image candidates to generate"></textarea>
        </label>
        <div class="control-grid">
          <label>Count
            <select id="count">
              <option>1</option>
              <option selected>2</option>
              <option>3</option>
              <option>4</option>
            </select>
          </label>
          <label>Size
            <select id="size">
              <option selected>auto</option>
              <option>1024x1024</option>
              <option>1536x1024</option>
              <option>1024x1536</option>
            </select>
          </label>
        </div>
        <label>Quality
          <select id="quality">
            <option selected>auto</option>
            <option>low</option>
            <option>medium</option>
            <option>high</option>
          </select>
        </label>
        <div class="row">
          <button id="generate">Generate</button>
          <button class="secondary" id="interrupt">Interrupt</button>
        </div>
      </section>
      <section class="stack">
        <strong>Activity</strong>
        <div class="log" id="log"></div>
      </section>
    </aside>
    <main class="pane">
      <div id="gallery" class="gallery"></div>
    </main>
    <aside class="pane preview" id="preview"></aside>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = null;

    const el = (id) => document.getElementById(id);
    const post = (message) => vscode.postMessage(message);

    el("refresh").addEventListener("click", () => post({ type: "refresh" }));
    el("generate").addEventListener("click", () => {
      const prompt = el("prompt").value.trim();
      if (!prompt) return;
      post({
        type: "generate",
        request: {
          prompt,
          count: Number(el("count").value),
          size: el("size").value,
          quality: el("quality").value
        }
      });
    });
    el("interrupt").addEventListener("click", () => post({ type: "interrupt" }));

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "state") {
        state = message.state;
        render();
      }
      if (message.type === "appendLog") {
        appendLog(message.line);
      }
      if (message.type === "error") {
        appendLog("Error: " + message.message);
      }
    });

    function render() {
      if (!state) return;
      renderSessions();
      renderAuth();
      renderGallery();
      renderPreview();
      renderLog();
      el("interrupt").disabled = !state.activeTurnId;
    }

    function renderSessions() {
      const manifest = state.manifest || { sessions: [], activeSessionId: "" };
      const container = el("sessions");
      container.innerHTML = "";
      const title = document.createElement("strong");
      title.textContent = "Session";
      const row = document.createElement("div");
      row.className = "row";
      const select = document.createElement("select");
      for (const session of manifest.sessions || []) {
        const option = document.createElement("option");
        option.value = session.id;
        option.textContent = session.name;
        option.selected = session.id === manifest.activeSessionId;
        select.append(option);
      }
      select.addEventListener("change", () => post({ type: "switchSession", sessionId: select.value }));
      const button = document.createElement("button");
      button.textContent = "New";
      button.className = "secondary";
      button.addEventListener("click", () => post({ type: "newSession" }));
      row.append(select, button);
      container.append(title, row);
    }

    function renderAuth() {
      const auth = state.auth || {};
      const container = el("auth");
      const rate = auth.rateLimits && auth.rateLimits.primary
        ? Math.round(auth.rateLimits.primary.usedPercent || 0) + "% used"
        : "Rate limit unavailable";
      const loggedIn = auth.authMode === "chatgpt";
      container.innerHTML = "";
      const title = document.createElement("strong");
      title.textContent = loggedIn ? "ChatGPT connected" : "ChatGPT not connected";
      const detail = document.createElement("span");
      detail.textContent = loggedIn
        ? [auth.email, auth.planType, rate].filter(Boolean).join(" · ")
        : "Log in before generating images.";
      const row = document.createElement("div");
      row.className = "row";
      const button = document.createElement("button");
      button.textContent = loggedIn ? "Log out" : "Log in";
      button.className = loggedIn ? "secondary" : "";
      button.addEventListener("click", () => post({ type: loggedIn ? "logout" : "login" }));
      row.append(button);
      container.append(title, detail, row);
    }

    function renderGallery() {
      const gallery = el("gallery");
      const manifest = state.manifest || { assets: [] };
      const assets = (manifest.assets || []).filter((asset) => asset.sessionId === manifest.activeSessionId);
      gallery.innerHTML = "";
      if (!assets.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Generated candidates will appear here.";
        gallery.append(empty);
        return;
      }

      for (const asset of assets.slice().reverse()) {
        const card = document.createElement("article");
        card.className = "asset-card" + (asset.id === manifest.selectedAssetId ? " selected" : "");
        card.addEventListener("click", () => post({ type: "select", assetId: asset.id }));

        const thumb = document.createElement("div");
        thumb.className = "thumb";
        if (asset.status === "ready") {
          const img = document.createElement("img");
          img.src = asset.thumbnailPath || asset.path;
          img.alt = asset.prompt || asset.id;
          thumb.append(img);
        } else {
          thumb.textContent = asset.status === "generating" ? "Generating..." : "Failed";
        }

        const info = document.createElement("div");
        info.className = "asset-info";
        const title = document.createElement("div");
        title.className = "asset-title";
        title.textContent = asset.editInstruction || asset.prompt || asset.id;
        const badge = document.createElement("span");
        badge.className = "badge" + (asset.status === "failed" ? " failed" : "");
        badge.textContent = asset.status;
        info.append(title, badge);

        card.append(thumb, info);
        gallery.append(card);
      }
    }

    function renderPreview() {
      const preview = el("preview");
      const manifest = state.manifest || { assets: [] };
      const selected = (manifest.assets || []).find((asset) => asset.id === manifest.selectedAssetId && asset.sessionId === manifest.activeSessionId);
      preview.innerHTML = "";
      if (!selected) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Select an image to continue editing.";
        preview.append(empty);
        return;
      }

      const box = document.createElement("div");
      box.className = "preview-box";
      if (selected.status === "ready") {
        const img = document.createElement("img");
        img.src = selected.path;
        img.alt = selected.prompt || selected.id;
        box.append(img);
      } else {
        box.textContent = selected.status;
      }

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = [selected.id, selected.parentId ? "parent " + selected.parentId : "", selected.createdAt].filter(Boolean).join(" · ");

      const instruction = document.createElement("textarea");
      instruction.id = "editInstruction";
      instruction.placeholder = "Describe the next edit for the selected image";

      const row = document.createElement("div");
      row.className = "row";
      const edit = document.createElement("button");
      edit.textContent = "Edit Selected";
      edit.disabled = selected.status !== "ready";
      edit.addEventListener("click", () => {
        const text = instruction.value.trim();
        if (!text) return;
        post({
          type: "edit",
          request: {
            assetId: selected.id,
            instruction: text,
            size: el("size").value,
            quality: el("quality").value
          }
        });
      });
      const reveal = document.createElement("button");
      reveal.textContent = "Reveal";
      reveal.className = "secondary";
      reveal.disabled = selected.status !== "ready";
      reveal.addEventListener("click", () => post({ type: "reveal", assetId: selected.id }));
      const retry = document.createElement("button");
      retry.textContent = "Retry";
      retry.className = "secondary";
      retry.disabled = selected.status === "generating";
      retry.addEventListener("click", () => post({ type: "retry", assetId: selected.id }));
      row.append(edit, reveal, retry);

      if (selected.error) {
        const error = document.createElement("div");
        error.className = "meta";
        error.style.color = "var(--danger)";
        error.textContent = selected.error;
        preview.append(box, meta, error, instruction, row);
      } else {
        preview.append(box, meta, instruction, row);
      }
    }

    function renderLog() {
      el("log").textContent = (state.log || []).join("\\n");
    }

    function appendLog(line) {
      const log = el("log");
      log.textContent = (log.textContent ? log.textContent + "\\n" : "") + line;
      log.scrollTop = log.scrollHeight;
    }

    post({ type: "ready" });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
