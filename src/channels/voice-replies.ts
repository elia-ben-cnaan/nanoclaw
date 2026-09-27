import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { OutboundMessage } from './adapter.js';

const MAX_SPOKEN_CHARS = 220;

export function voiceRepliesEnabled(): boolean {
  const env = readEnvFile(['VOICE_REPLIES_ENABLED', 'VOICE_TTS_PROVIDER', 'VOICE_TTS_API_KEY']);
  // The key is intentionally host-only. It is never mounted into an agent
  // container and no MCP tool exposes it to agents or their subagents.
  return env.VOICE_REPLIES_ENABLED === 'true' && env.VOICE_TTS_PROVIDER === 'openai' && !!env.VOICE_TTS_API_KEY;
}

export function spokenText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown>;
  // The delivery host adds this marker only after it has verified both the
  // requesting user message and the source agent-group allowlist.
  if (content.voiceReply !== true || content.type === 'card' || content.type === 'ask_question' || content.operation)
    return null;
  const raw =
    typeof content.markdown === 'string' ? content.markdown : typeof content.text === 'string' ? content.text : '';
  const text = raw
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, MAX_SPOKEN_CHARS) : null;
}

/** Produce a short, natural MP3 reply through the dedicated OpenAI TTS key. */
export async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  const env = readEnvFile(['VOICE_TTS_API_KEY', 'VOICE_TTS_MODEL', 'VOICE_TTS_VOICE']);
  const apiKey = env.VOICE_TTS_API_KEY;
  if (!apiKey) return null;
  const language = /[\u0590-\u05ff]/.test(text) ? 'he' : 'en';
  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.VOICE_TTS_MODEL || 'gpt-4o-mini-tts',
        voice: env.VOICE_TTS_VOICE || 'marin',
        input: text,
        response_format: 'mp3',
        instructions:
          language === 'he'
            ? 'דברי בעברית טבעית, חמה וברורה, בקצב שיחה רגיל. בלי סגנון רובוטי.'
            : 'Speak naturally, warmly, and clearly at a conversational pace.',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`TTS response ${response.status}`);
    const audio = Buffer.from(await response.arrayBuffer());
    return audio.length > 0 ? audio : null;
  } catch (err) {
    log.warn('Voice reply synthesis failed; text reply remains available', { err });
    return null;
  }
}
