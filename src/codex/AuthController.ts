import * as vscode from "vscode";
import type { AuthState, JsonObject, RateLimits, RpcNotification } from "../types";
import { AppServerClient } from "./AppServerClient";

export class AuthController implements vscode.Disposable {
  private state: AuthState = {
    authMode: null,
    planType: null,
    rateLimits: null,
  };

  private readonly changed = new vscode.EventEmitter<AuthState>();
  private readonly subscriptions: vscode.Disposable[] = [];

  readonly onDidChange = this.changed.event;

  constructor(private readonly client: AppServerClient) {
    this.subscriptions.push(
      this.client.onNotification((notification) => this.handleNotification(notification)),
    );
  }

  get current(): AuthState {
    return this.state;
  }

  async refresh(): Promise<AuthState> {
    const result = await this.client.request<{ account?: unknown; requiresOpenaiAuth?: boolean }>("account/read", {
      refreshToken: false,
    });

    const account = isRecord(result.account) ? result.account : null;
    if (!account) {
      this.update({
        authMode: null,
        planType: null,
        requiresOpenaiAuth: result.requiresOpenaiAuth,
        rateLimits: null,
      });
      return this.state;
    }

    const type = stringOrNull(account.type);
    this.update({
      authMode: isAuthMode(type) ? type : null,
      planType: stringOrNull(account.planType),
      email: stringOrUndefined(account.email),
      requiresOpenaiAuth: result.requiresOpenaiAuth,
      rateLimits: this.state.rateLimits,
    });

    if (this.state.authMode === "chatgpt") {
      await this.refreshRateLimits();
    }

    return this.state;
  }

  async loginWithChatGpt(): Promise<void> {
    const result = await this.client.request<JsonObject>("account/login/start", { type: "chatgpt" });
    const authUrl = typeof result.authUrl === "string" ? result.authUrl : undefined;
    if (!authUrl) {
      throw new Error("Codex app-server did not return a ChatGPT auth URL.");
    }

    await vscode.env.openExternal(vscode.Uri.parse(authUrl));
  }

  async logout(): Promise<void> {
    await this.client.request("account/logout");
    this.update({ authMode: null, planType: null, rateLimits: null });
  }

  async refreshRateLimits(): Promise<void> {
    try {
      const result = await this.client.request<{ rateLimits?: RateLimits }>("account/rateLimits/read");
      this.update({ ...this.state, rateLimits: result.rateLimits ?? null });
    } catch {
      this.update({ ...this.state, rateLimits: null });
    }
  }

  private handleNotification(notification: RpcNotification): void {
    if (notification.method === "account/updated") {
      const params = notification.params ?? {};
      this.update({
        ...this.state,
        authMode: isAuthMode(params.authMode) ? params.authMode : null,
        planType: stringOrNull(params.planType),
      });
      void this.refreshRateLimits();
    }

    if (notification.method === "account/rateLimits/updated") {
      const params = notification.params ?? {};
      this.update({ ...this.state, rateLimits: isRecord(params.rateLimits) ? params.rateLimits as RateLimits : null });
    }
  }

  private update(state: AuthState): void {
    this.state = state;
    this.changed.fire(this.state);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.changed.dispose();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isAuthMode(value: unknown): value is AuthState["authMode"] {
  return value === "apikey" || value === "chatgpt" || value === "chatgptAuthTokens" || value === null;
}
