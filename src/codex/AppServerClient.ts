import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";
import type { JsonObject, RpcMessage, RpcNotification, RpcResponse } from "../types";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export class AppServerClient implements vscode.Disposable {
  private proc?: ChildProcessWithoutNullStreams;
  private rl?: readline.Interface;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private initialized = false;
  private readonly notifications = new vscode.EventEmitter<RpcNotification>();
  private readonly output: vscode.OutputChannel;

  readonly onNotification = this.notifications.event;

  constructor(output: vscode.OutputChannel, private readonly codexHomePath: string) {
    this.output = output;
  }

  async start(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      return;
    }

    const command = resolveCodexCommand();
    this.output.appendLine(`Launching Codex app-server: ${command}`);

    this.proc = spawn(command, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_HOME: this.codexHomePath,
      },
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.output.append(chunk.toString());
    });

    this.proc.on("error", (error) => {
      this.rejectAll(error);
    });

    this.proc.on("exit", (code, signal) => {
      this.initialized = false;
      this.proc = undefined;
      this.rejectAll(new Error(`codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}`));
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    await this.initialize();
  }

  async request<T = unknown>(method: string, params?: JsonObject): Promise<T> {
    await this.ensureStarted();

    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.proc?.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise as Promise<T>;
  }

  notify(method: string, params?: JsonObject): void {
    const payload = params === undefined ? { method } : { method, params };
    this.proc?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private async ensureStarted(): Promise<void> {
    if (!this.proc || this.proc.killed || !this.initialized) {
      await this.start();
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.request("initialize", {
      clientInfo: {
        name: "vscode_codex_image_editor",
        title: "Codex Image Studio",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch (error) {
      this.output.appendLine(`Failed to parse app-server message: ${String(error)}`);
      this.output.appendLine(line);
      return;
    }

    if (typeof (message as RpcResponse).id === "number") {
      this.handleResponse(message as RpcResponse);
      return;
    }

    if (typeof (message as RpcNotification).method === "string") {
      this.notifications.fire(message as RpcNotification);
    }
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }

    pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  dispose(): void {
    this.notifications.dispose();
    this.rl?.close();
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
  }
}

function resolveCodexCommand(): string {
  const candidates = [
    ...findBundledCodexCommands(),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];

  const command = candidates.find((candidate) => fs.existsSync(candidate));
  if (!command) {
    throw new Error(
      "Codex CLI was not found in a trusted location. Install the ChatGPT VS Code extension or Codex CLI via Homebrew.",
    );
  }

  return command;
}

function findBundledCodexCommands(): string[] {
  const extensionRoots = [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".vscode-insiders", "extensions"),
  ];

  const commands: string[] = [];
  for (const extensionRoot of extensionRoots) {
    try {
      commands.push(
        ...fs.readdirSync(extensionRoot)
          .filter((name) => name.startsWith("openai.chatgpt-"))
          .sort()
          .reverse()
          .map((name) => path.join(extensionRoot, name, "bin", "macos-aarch64", "codex"))
          .filter((candidate) => fs.existsSync(candidate)),
      );
    } catch {
      // Ignore missing extension roots.
    }
  }

  return commands;
}
