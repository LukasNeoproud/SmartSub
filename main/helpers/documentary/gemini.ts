import { createHash } from 'crypto';
import type { DocumentarySettings } from '../../../types/documentary';
import { assertDocumentarySettings, effectiveDocumentaryVoice } from '../../../types/documentary';
import { checkAbort, abortError } from './process';

/** Reviewed against Google's speech-generation REST guide, 2026-09-26. */
export function geminiRequest(text: string, settings: DocumentarySettings): Record<string, unknown> {
  assertDocumentarySettings(settings);
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > 4000) {
    throw new Error('Each spoken segment must contain 1–4000 UTF-8 bytes; split this cue in Review');
  }
  const style = `Speak natural ${settings.language}. ${settings.style}`;
  // 3.8 separates style from verbatim text; older models use a combined prompt.
  const structured = /^gemini-3\.8-/.test(settings.model);
  if (settings.voiceSource === 'custom' && !structured) {
    throw new Error('Designed voice IDs require a Gemini 3.8 TTS model');
  }
  const voice = effectiveDocumentaryVoice(settings);
  return {
    contents: [{ role: 'user', parts: [structured
      ? { text, speech_metadata: { style } }
      : { text: `${style}\nRead only the following text verbatim. Do not translate, add words or read these instructions:\n${text}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: structured
        ? { voice }
        : { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
}

/** Deliberately excludes timings, mix settings, speed and credentials. */
export function documentarySynthesisKey(text: string, settings: DocumentarySettings): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, model: settings.model,
    request: geminiRequest(text, settings) })).digest('hex');
}

export function decodeGeminiAudio(body: any): Buffer {
  const candidate = body?.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`Google TTS did not finish: ${String(candidate.finishReason)}`);
  }
  const parts = candidate?.content?.parts;
  const audio = Array.isArray(parts) ? parts.filter((part: any) => part.inlineData?.data) : [];
  if (audio.length !== 1) throw new Error('Google TTS returned no complete audio segment (possibly blocked or truncated)');
  const inline = audio[0].inlineData;
  if (typeof inline.data !== 'string' || inline.data.length > 64 * 1024 * 1024) throw new Error('Invalid Google audio payload');
  const data = Buffer.from(inline.data, 'base64');
  if (data.length >= 44 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') return data;
  // Legacy Gemini returns raw signed little-endian PCM despite the audio/L16 MIME label.
  const mime = String(inline.mimeType || '');
  const rate = Number(/rate=(\d+)/i.exec(mime)?.[1]);
  if (!/^audio\/(?:L16|pcm)(?:;|$)/i.test(mime) || !Number.isInteger(rate) || rate < 8000 || rate > 96000 ||
      !data.length || data.length % 2 !== 0) throw new Error(`Unsupported Google audio format: ${mime}`);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function synthesizeGemini(
  text: string, settings: DocumentarySettings, apiKey: string,
  signal?: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  if (!apiKey.trim()) throw new Error('Set a Google Gemini API key before synthesis');
  const payload = JSON.stringify(geminiRequest(text, settings));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`;
  for (let attempt = 0; attempt < 3; attempt++) {
    checkAbort(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), 120000);
    let retryMs: number | undefined;
    try {
      const response = await fetcher(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: payload, signal: controller.signal,
      });
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
        const seconds = Number(response.headers.get('retry-after'));
        retryMs = Math.min(30000, Math.max(1000 * 2 ** attempt, Number.isFinite(seconds) ? seconds * 1000 : 0));
        await response.body?.cancel();
      } else {
        if (!response.ok) {
          // Do not expose request headers, provider response bodies or keys to logs/UI.
          throw new Error(`Google TTS HTTP ${response.status}. Check model availability, API key, billing and quota.`);
        }
        return decodeGeminiAudio(await response.json());
      }
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (controller.signal.aborted) throw new Error('Google TTS timed out after 120 seconds; retry this cue');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (retryMs !== undefined) await delay(retryMs, signal);
  }
  throw new Error('Google TTS retry limit reached');
}
