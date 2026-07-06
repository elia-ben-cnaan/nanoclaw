/**
 * Host-side container config for the `codex` provider.
 *
 * Codex reads auth and MCP config from ~/.codex. We give each session its
 * own private copy of that directory so:
 *
 * - The user's host ~/.codex/auth.json reaches the container without us
 *   touching their host config.toml (which the host's own `codex` CLI
 *   might be using).
 * - The in-container provider can rewrite config.toml freely on every
 *   wake with container-appropriate MCP server paths, without racing
 *   other sessions or leaking per-session paths back to the host.
 *
 * Env passthrough covers the two knobs that are read at runtime:
 *   OPENAI_API_KEY  — fallback auth when auth.json isn't a subscription token
 *   CODEX_MODEL     — model override if the user wants something other than the default
 *   OPENAI_BASE_URL — rare, but supports API-compatible alternates
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  // Copy the host's auth.json into the per-session dir if it exists.
  // We only copy auth.json, not the full ~/.codex — config.toml would
  // get clobbered by the container on every wake anyway.
  const hostHome = ctx.hostEnv.HOME;
  if (hostHome) {
    const hostAuth = path.join(hostHome, '.codex', 'auth.json');
    if (fs.existsSync(hostAuth)) {
      fs.copyFileSync(hostAuth, path.join(codexDir, 'auth.json'));
    }
  }

  // Read from .env (not process.env — this host keeps secrets out of the
  // process environment; readEnvFile is the same path the claude provider
  // uses). OPENAI_API_KEY is a non-empty placeholder here: the OneCLI
  // gateway rewrites the Authorization header for api.openai.com calls with
  // the real vaulted OpenAI secret, so the raw key never enters the container.
  const dotenv = readEnvFile(['OPENAI_API_KEY', 'CODEX_MODEL', 'OPENAI_BASE_URL']);
  const env: Record<string, string> = {};
  for (const key of ['OPENAI_API_KEY', 'CODEX_MODEL', 'OPENAI_BASE_URL'] as const) {
    if (dotenv[key]) env[key] = dotenv[key];
  }

  return {
    mounts: [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }],
    env,
  };
});
