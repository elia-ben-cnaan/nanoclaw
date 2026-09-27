import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import type { MessageInRow } from './db/messages-in.js';

const TRANSCRIBER_HOST = 'host.docker.internal';
const TRANSCRIBER_PORT = 8766;
const TRANSCRIBER_TIMEOUT_MS = 120_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const execFileAsync = promisify(execFile);

type MessageContent = {
  text?: string;
  attachments?: Array<{ type?: string; mimetype?: string; name?: string; filename?: string; localPath?: string }>;
};

function isAudio(attachment: NonNullable<MessageContent['attachments']>[number]): boolean {
  const type = (attachment.type ?? '').toLowerCase();
  const mime = (attachment.mimetype ?? '').toLowerCase();
  return type === 'voice' || type === 'audio' || mime.startsWith('audio/');
}

async function requestTranscript(filePath: string, fileName: string): Promise<string | null> {
  const stat = fs.statSync(filePath);
  if (stat.size <= 0 || stat.size > MAX_AUDIO_BYTES) return null;
  try {
    // `curl --noproxy` bypasses the OneCLI HTTPS proxy. The Whisper service is
    // on the Docker bridge only; using a direct request keeps audio local.
    const { stdout } = await execFileAsync(
      'curl',
      [
        '--noproxy', '*', '--max-time', String(Math.ceil(TRANSCRIBER_TIMEOUT_MS / 1000)),
        '--fail', '--silent', '--show-error', '-X', 'POST',
        '-H', `X-Filename: ${fileName}`,
        '--data-binary', `@${filePath}`,
        `http://${TRANSCRIBER_HOST}:${TRANSCRIBER_PORT}/transcribe`,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const body = JSON.parse(stdout) as { text?: unknown };
    return typeof body.text === 'string' && body.text.trim() ? body.text.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Adds a local transcript to voice-message content before it reaches either
 * Claude or Codex. Failures are deliberately non-fatal: the original audio
 * attachment remains available to the agent.
 */
export async function enrichVoiceTranscripts(messages: MessageInRow[]): Promise<MessageInRow[]> {
  return Promise.all(messages.map(async (message) => {
    if (message.kind !== 'chat' && message.kind !== 'chat-sdk') return message;
    let content: MessageContent;
    try {
      content = JSON.parse(message.content) as MessageContent;
    } catch {
      return message;
    }
    const audio = content.attachments?.find(isAudio);
    if (!audio?.localPath) return message;

    const workspace = '/workspace';
    const sourcePath = path.resolve(workspace, audio.localPath);
    if (!sourcePath.startsWith(`${workspace}/`) || !fs.existsSync(sourcePath)) return message;
    const transcript = await requestTranscript(sourcePath, audio.name ?? audio.filename ?? 'voice.ogg');
    if (!transcript) return message;

    const original = content.text?.trim();
    content.text = `${original ? `${original}\n\n` : ''}[תמלול מקומי של הודעת קול]\n${transcript}`;
    return { ...message, content: JSON.stringify(content) };
  }));
}
