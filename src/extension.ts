import * as vscode from "vscode";
import { AppServerClient } from "./codex/AppServerClient";
import { AuthController } from "./codex/AuthController";
import { TurnOrchestrator } from "./codex/TurnOrchestrator";
import { WorkspaceStore } from "./storage/WorkspaceStore";
import { ImageStudioPanel } from "./webview/ImageStudioPanel";

type Runtime = {
  output: vscode.OutputChannel;
  client: AppServerClient;
  auth: AuthController;
  store: WorkspaceStore;
  turns: TurnOrchestrator;
  panel: ImageStudioPanel;
};

let runtime: Runtime | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Codex Image Studio");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("codexImageEditor.open", async () => {
      const rt = await getRuntime(context, output);
      rt.panel.reveal();
      await rt.auth.refresh();
      await rt.store.read();
    }),
    vscode.commands.registerCommand("codexImageEditor.login", async () => {
      const rt = await getRuntime(context, output);
      await runWithErrors(rt.panel, async () => rt.auth.loginWithChatGpt());
    }),
    vscode.commands.registerCommand("codexImageEditor.logout", async () => {
      const rt = await getRuntime(context, output);
      await runWithErrors(rt.panel, async () => rt.auth.logout());
    }),
    vscode.commands.registerCommand("codexImageEditor.refresh", async () => {
      const rt = await getRuntime(context, output);
      await refresh(rt);
    }),
    vscode.commands.registerCommand("codexImageEditor.interrupt", async () => {
      const rt = await getRuntime(context, output);
      await runWithErrors(rt.panel, async () => rt.turns.interrupt());
    }),
    vscode.commands.registerCommand("codexImageEditor.newSession", async () => {
      const rt = await getRuntime(context, output);
      await runWithErrors(rt.panel, async () => {
        await rt.store.createSession();
        rt.turns.resetActiveSessionThread();
      });
    }),
  );
}

export function deactivate(): void {
  runtime?.panel.dispose();
  runtime?.turns.dispose();
  runtime?.auth.dispose();
  runtime?.client.dispose();
  runtime?.store.dispose();
  runtime = undefined;
}

async function getRuntime(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<Runtime> {
  if (runtime) {
    return runtime;
  }

  const store = WorkspaceStore.fromActiveWorkspace();
  await store.initialize();

  const codexHomeUri = vscode.Uri.joinPath(context.globalStorageUri, "codex-home");
  const codexSessionsUri = vscode.Uri.joinPath(codexHomeUri, "sessions");
  const codexGeneratedImagesUri = vscode.Uri.joinPath(codexHomeUri, "generated_images");
  const extensionGeneratedImagesUri = vscode.Uri.joinPath(context.globalStorageUri, "generated-images");
  await initializeRuntimeDirectories(codexHomeUri, codexSessionsUri, codexGeneratedImagesUri, extensionGeneratedImagesUri);
  output.appendLine(`Using Codex home: ${codexHomeUri.fsPath}`);

  const client = new AppServerClient(output, codexHomeUri.fsPath);
  const auth = new AuthController(client);
  const turns = new TurnOrchestrator(client, store, codexSessionsUri.fsPath, [
    codexGeneratedImagesUri.fsPath,
    extensionGeneratedImagesUri.fsPath,
  ]);

  const panel = new ImageStudioPanel(context.extensionUri, store, {
    login: async () => {
      await auth.loginWithChatGpt();
    },
    logout: async () => {
      await auth.logout();
    },
    refresh: async () => {
      await refresh(requireRuntime());
    },
    newSession: async () => {
      await store.createSession();
      turns.resetActiveSessionThread();
    },
    switchSession: async (sessionId) => {
      await store.switchSession(sessionId);
      turns.activateSession();
    },
    generate: async (prompt, count, size, quality) => {
      await ensureChatGptAuth(auth);
      await turns.generate({ prompt, count, size, quality });
    },
    edit: async (assetId, instruction, size, quality) => {
      await ensureChatGptAuth(auth);
      await turns.edit({ assetId, instruction, size, quality });
    },
    select: async (assetId) => {
      await store.selectAsset(assetId);
    },
    retry: async (assetId) => {
      await ensureChatGptAuth(auth);
      await turns.retry(assetId);
    },
    interrupt: async () => {
      await turns.interrupt();
    },
    reveal: async (assetId) => {
      const asset = store.assetById(assetId);
      if (!asset) {
        return;
      }
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(store.assetAbsolutePath(asset)));
    },
  }, auth.current);

  context.subscriptions.push(store, client, auth, turns, panel);

  store.onDidChange((manifest) => panel.updateManifest(manifest));
  auth.onDidChange((authState) => panel.updateAuth(authState));
  turns.onDidChange(() => panel.updateActiveTurn(turns.currentTurnId));
  turns.onLogLine((line) => panel.appendLog(line));

  runtime = {
    output,
    client,
    auth,
    store,
    turns,
    panel,
  };

  await refresh(runtime);
  return runtime;
}

async function initializeRuntimeDirectories(
  codexHomeUri: vscode.Uri,
  codexSessionsUri: vscode.Uri,
  codexGeneratedImagesUri: vscode.Uri,
  extensionGeneratedImagesUri: vscode.Uri,
): Promise<void> {
  await vscode.workspace.fs.createDirectory(codexHomeUri);
  await vscode.workspace.fs.createDirectory(codexSessionsUri);
  await vscode.workspace.fs.createDirectory(codexGeneratedImagesUri);
  await vscode.workspace.fs.createDirectory(extensionGeneratedImagesUri);
}

function requireRuntime(): Runtime {
  if (!runtime) {
    throw new Error("Codex Image Studio is not initialized.");
  }
  return runtime;
}

async function refresh(rt: Runtime): Promise<void> {
  await runWithErrors(rt.panel, async () => {
    await rt.auth.refresh();
    await rt.store.read();
    await rt.store.reconcileAssetFiles();
    rt.panel.updateActiveTurn(rt.turns.currentTurnId);
  });
}

async function ensureChatGptAuth(auth: AuthController): Promise<void> {
  const state = await auth.refresh();
  if (state.authMode === "chatgpt") {
    return;
  }

  await auth.loginWithChatGpt();
  throw new Error("Finish the ChatGPT login flow in your browser, then run the request again.");
}

async function runWithErrors(panel: ImageStudioPanel, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    panel.showError(error instanceof Error ? error.message : String(error));
  }
}
