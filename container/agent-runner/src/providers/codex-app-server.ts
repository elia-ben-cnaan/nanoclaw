/**
 * Codex app-server JSON-RPC transport primitives.
 *
 * Communicates with `codex app-server` over stdio. This module is just the
 * plumbing — spawn the process, send requests, dispatch responses and
 * notifications. Higher-level semantics (threads, turns, event translation)
 * live in codex.ts.
 *
 * Kept separate so the transport can be unit-tested without pulling in the
 * full provider and so any future Codex tooling (e.g. a CLI for manual
 * debugging) can reuse the same primitives.
 */
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

function log(msg: string): void {
  console.error(`[codex-app-server] ${msg}`);
}

const INIT_TIMEOUT_MS = 30_000;

// ── JSON-RPC types ──────────────────────────────────────────────────────────

let nextRequestId = 1;

interface JsonRpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcServerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

function makeRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
  return { id: nextRequestId++, method, params };
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

function isServerRequest(msg: JsonRpcMessage): msg is JsonRpcServerRequest {
  return 'id' in msg && 'method' in msg;
}

// ── App-server handle ───────────────────────────────────────────────────────

export interface AppServer {
  process: ChildProcess;
  externalAccessToken?: string;
  readline: ReadlineInterface;
  pending: Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>;
  notificationHandlers: ((n: JsonRpcNotification) => void)[];
  serverRequestHandlers: ((r: JsonRpcServerRequest) => void)[];
}

export function spawnCodexAppServer(configOverrides: string[] = []): AppServer {
  const args = ['app-server', '--listen', 'stdio://'];
  for (const override of configOverrides) args.push('-c', override);

  // CLI images installed through the NanoClaw manifest expose Codex at
  // /pnpm/codex, while some images put it on PATH. Prefer the manifest path.
  const codexBinary = fs.existsSync('/pnpm/codex') ? '/pnpm/codex' : 'codex';
  log(`Spawning: ${codexBinary} ${args.join(' ')}`);
  const env = { ...process.env };
  if (env.NANOCLAW_CODEX_AUTH === 'chatgpt') {
    // Keep the TLS CA needed by the server network, without retaining the API proxy.
    const caCertificate = env.CODEX_CA_CERTIFICATE || env.NODE_EXTRA_CA_CERTS || env.SSL_CERT_FILE || env.DENO_CERT;
    // OneCLI remains available to the rest of the agent, but Codex itself
    // must not inherit the API credential or proxy that injects one.
    for (const key of [
      'OPENAI_API_KEY', 'OPENAI_BASE_URL',
      'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
      'ALL_PROXY', 'all_proxy', 'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE', 'DENO_CERT', 'CODEX_CA_CERTIFICATE', 'NODE_USE_ENV_PROXY',
    ]) delete env[key];
    if (caCertificate) env.CODEX_CA_CERTIFICATE = caCertificate;
  }
  const proc = spawn(codexBinary, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  const rl = createInterface({ input: proc.stdout! });

  const server: AppServer = {
    process: proc,
    readline: rl,
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
  };

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log(`[stderr] ${text}`);
  });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`[parse-error] ${line.slice(0, 200)}`);
      return;
    }

    if (isResponse(msg)) {
      const handler = server.pending.get(msg.id);
      if (handler) {
        server.pending.delete(msg.id);
        handler.resolve(msg);
      }
    } else if (isServerRequest(msg)) {
      for (const h of server.serverRequestHandlers) h(msg);
    } else if ('method' in msg) {
      for (const h of server.notificationHandlers) h(msg as JsonRpcNotification);
    }
  });

  proc.on('error', (err) => {
    log(`[process-error] ${err.message}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  proc.on('exit', (code, signal) => {
    log(`[exit] code=${code} signal=${signal}`);
    const err = new Error(`Codex app-server exited: code=${code} signal=${signal}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  return server;
}

export function sendCodexRequest(
  server: AppServer,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<JsonRpcResponse> {
  const req = makeRequest(method, params);
  const line = JSON.stringify(req) + '\n';

  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.pending.delete(req.id);
      reject(new Error(`Timeout waiting for ${method} response (${timeoutMs}ms)`));
    }, timeoutMs);

    server.pending.set(req.id, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });

    try {
      server.process.stdin!.write(line);
    } catch (err) {
      clearTimeout(timer);
      server.pending.delete(req.id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function sendCodexResponse(server: AppServer, id: number, result: unknown): void {
  const line = JSON.stringify({ id, result }) + '\n';
  try {
    server.process.stdin!.write(line);
  } catch (err) {
    log(`[send-error] Failed to send response for id=${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function killCodexAppServer(server: AppServer): void {
  try {
    server.readline.close();
    server.process.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

// ── Auto-approval ───────────────────────────────────────────────────────────
// The container sandbox is already the security boundary; inside it, Codex's
// own approval prompts would just block every tool call on a user that isn't
// watching. Accept everything and let sandbox limits do the enforcement.

export function attachCodexAutoApproval(server: AppServer): void {
  server.serverRequestHandlers.push((req) => {
    const method = req.method;
    log(`[approval] ${method}`);

    switch (method) {
      case 'account/chatgptAuthTokens/refresh': {
        // The desktop remains the sole owner of its rotating refresh token.
        // Only accept a NEW valid access-token snapshot; never claim to refresh it here.
        try {
          const auth = readExternalChatGPTAuth();
          if (!auth || auth.accessToken === server.externalAccessToken) throw new Error('snapshot unchanged');
          server.externalAccessToken = auth.accessToken;
          sendCodexResponse(server, req.id, auth);
        } catch {
          server.process.stdin!.write(JSON.stringify({ id: req.id, error: {
            code: -32001, message: 'Linked desktop authorization needs an updated access-token snapshot',
          } }) + '\n');
        }
        break;
      }
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        sendCodexResponse(server, req.id, { decision: 'accept' });
        break;
      case 'item/permissions/requestApproval':
        sendCodexResponse(server, req.id, {
          permissions: { fileSystem: { read: ['/'], write: ['/'] }, network: { enabled: true } },
          scope: 'session',
        });
        break;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        sendCodexResponse(server, req.id, { decision: 'approved' });
        break;
      case 'item/tool/call': {
        const toolName = (req.params as { tool?: string }).tool || 'unknown';
        log(`[approval] Unexpected dynamic tool call: ${toolName}`);
        sendCodexResponse(server, req.id, {
          success: false,
          contentItems: [{ type: 'inputText', text: `Tool "${toolName}" is not available. Use MCP tools instead.` }],
        });
        break;
      }
      case 'item/tool/requestUserInput':
      case 'mcpServer/elicitation/request':
        sendCodexResponse(server, req.id, { input: null });
        break;
      default:
        log(`[approval] Unknown method ${method}, generic accept`);
        sendCodexResponse(server, req.id, { decision: 'accept' });
        break;
    }
  });
}

// ── High-level helpers ──────────────────────────────────────────────────────

export interface ExternalChatGPTAuth {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string;
}

export function validateExternalChatGPTAuth(data: unknown): ExternalChatGPTAuth {
  const auth = data as Partial<ExternalChatGPTAuth> | null;
  if (!auth || typeof auth.accessToken !== 'string' || !auth.accessToken ||
      typeof auth.chatgptAccountId !== 'string' || !auth.chatgptAccountId) throw new Error('Invalid external ChatGPT authorization');
  const payload = JSON.parse(Buffer.from(auth.accessToken.split('.')[1] || '', 'base64url').toString());
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now() + 60000) throw new Error('External ChatGPT authorization expired');
  // Pick only supported non-refresh fields, even if a malformed file includes extras.
  return { accessToken: auth.accessToken, chatgptAccountId: auth.chatgptAccountId,
    ...(typeof auth.chatgptPlanType === 'string' ? { chatgptPlanType: auth.chatgptPlanType } : {}) };
}

export function readExternalChatGPTAuth(): ExternalChatGPTAuth | undefined {
  const file = process.env.NANOCLAW_CODEX_EXTERNAL_AUTH_FILE;
  if (!file) return undefined;
  return validateExternalChatGPTAuth(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export async function initializeCodexAppServer(server: AppServer): Promise<void> {
  const externalAuth = readExternalChatGPTAuth();
  log('Sending initialize…');
  const resp = await sendCodexRequest(
    server,
    'initialize',
    {
      clientInfo: { name: 'nanoclaw', version: '1.0.0' },
      capabilities: { experimentalApi: !!externalAuth },
    },
    INIT_TIMEOUT_MS,
  );
  if (resp.error) throw new Error(`Initialize failed: ${resp.error.message}`);
  log('Initialize successful');
  if (externalAuth) {
    const login = await sendCodexRequest(server, 'account/login/start', { type: 'chatgptAuthTokens', ...externalAuth }, INIT_TIMEOUT_MS);
    if (login.error) throw new Error('External ChatGPT authorization failed');
    server.externalAccessToken = externalAuth.accessToken;
    log('Linked desktop ChatGPT authorization active (access token only; no refresh token)');
  }
}

export interface ThreadParams {
  model?: string;
  cwd: string;
  sandbox?: string;
  approvalPolicy?: string;
  personality?: string;
  baseInstructions?: string;
}

/**
 * Start or resume a Codex thread. If `threadId` is provided, attempts
 * `thread/resume` first and falls back to a fresh `thread/start` on failure
 * (stale thread IDs commonly outlive containers). Returns the active thread
 * ID either way.
 */
export async function startOrResumeCodexThread(
  server: AppServer,
  threadId: string | undefined,
  params: ThreadParams,
): Promise<string> {
  if (threadId) {
    log(`Resuming thread: ${threadId}`);
    const resp = await sendCodexRequest(server, 'thread/resume', {
      threadId,
      ...(params as unknown as Record<string, unknown>),
    });
    if (!resp.error) {
      log(`Thread resumed: ${threadId}`);
      return threadId;
    }
    log(`Resume failed: ${resp.error.message}. Starting fresh thread.`);
  }

  log('Starting new thread…');
  const resp = await sendCodexRequest(server, 'thread/start', {
    ...(params as unknown as Record<string, unknown>),
  });
  if (resp.error) throw new Error(`thread/start failed: ${resp.error.message}`);

  const result = resp.result as { thread?: { id?: string } } | undefined;
  const newThreadId = result?.thread?.id;
  if (!newThreadId) throw new Error('thread/start response missing thread ID');
  log(`New thread: ${newThreadId}`);
  return newThreadId;
}

export interface TurnParams {
  threadId: string;
  inputText: string;
  model?: string;
  cwd?: string;
}

export async function startCodexTurn(server: AppServer, params: TurnParams): Promise<void> {
  const resp = await sendCodexRequest(server, 'turn/start', {
    threadId: params.threadId,
    input: [{ type: 'text', text: params.inputText }],
    model: params.model,
    cwd: params.cwd,
  });
  if (resp.error) throw new Error(`turn/start failed: ${resp.error.message}`);
}

// ── MCP config.toml ─────────────────────────────────────────────────────────
// Codex discovers MCP servers by reading ~/.codex/config.toml at startup.
// We rewrite it on every spawn from whatever mcpServers the agent-runner
// passes in, so the container's config reflects the current host wiring.

export interface CodexMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export function writeCodexMcpConfigToml(servers: Record<string, CodexMcpServer>): void {
  const codexConfigDir = process.env.CODEX_HOME || path.join(process.env.HOME || '/home/node', '.codex');
  fs.mkdirSync(codexConfigDir, { recursive: true });
  const configTomlPath = path.join(codexConfigDir, 'config.toml');

  const lines: string[] = [];
  for (const [name, config] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push('type = "stdio"');
    lines.push(`command = "${config.command}"`);
    if (config.args && config.args.length > 0) {
      const argsStr = config.args.map((a) => `"${a}"`).join(', ');
      lines.push(`args = [${argsStr}]`);
    }
    if (config.env && Object.keys(config.env).length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(config.env)) {
        lines.push(`${key} = "${value}"`);
      }
    }
    lines.push('');
  }

  fs.writeFileSync(configTomlPath, lines.join('\n'));
  log(`Wrote MCP config.toml (${Object.keys(servers).length} server(s))`);
}

export function createCodexConfigOverrides(baseUrl?: string | null): string[] {
  const overrides = ['features.use_linux_sandbox_bwrap=false'];
  if (baseUrl) overrides.push(`model_provider_base_url="${baseUrl}"`);
  return overrides;
}
