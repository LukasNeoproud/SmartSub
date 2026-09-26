import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { endianness } from 'os';
import {
  DOCUMENTARY_RATE as RATE, MAX_DOCUMENTARY_CLIP_MS, documentaryDuckGain, duckIntervals,
  type DocumentaryClip, type DocumentaryCue, type DocumentaryMedia, type DocumentarySettings,
} from '../../../types/documentary';
import { runProcess, checkAbort, type DocumentaryTools } from './process';
import { probeDocumentary } from './media';

export interface DocumentaryAudioLayout { channels: 1 | 2 | 6; name: string }

export function documentaryLayout(media: DocumentaryMedia, audioIndex: number, requested: DocumentarySettings['layout']): DocumentaryAudioLayout {
  const stream = media.streams.find((s) => s.index === audioIndex && s.codec_type === 'audio');
  if (!stream) throw new Error('Select an existing source audio stream');
  if (requested === 'stereo') return { channels: 2, name: 'stereo' };
  if (requested === '5.1') return { channels: 6, name: '5.1(side)' };
  if (stream.channels === 1) return { channels: 1, name: 'mono' };
  if (stream.channels === 2) return { channels: 2, name: 'stereo' };
  if (stream.channels === 6 && ['5.1', '5.1(side)'].includes(stream.channel_layout || '')) {
    return { channels: 6, name: stream.channel_layout! };
  }
  throw new Error(`Unrecognized source layout ${stream.channel_layout || stream.channels}. Explicitly choose a 5.1 or stereo downmix.`);
}

export async function prepareDocumentaryClip(
  id: string, wavPath: string, speed: number, cacheDir: string, tools: DocumentaryTools, signal?: AbortSignal,
): Promise<DocumentaryClip> {
  checkAbort(signal);
  const raw = await fs.promises.readFile(wavPath);
  const key = createHash('sha256').update(raw).update(`:48k-mono-v1:${speed}`).digest('hex');
  const prepared = path.join(cacheDir, `${key}.f32`);
  if (!fs.existsSync(prepared)) {
    const info = await probeDocumentary(wavPath, tools, signal);
    if (info.durationMs > MAX_DOCUMENTARY_CLIP_MS) throw new Error('TTS clip exceeds 120 seconds. Split the cue instead of truncating it.');
    const temporary = `${prepared}.partial`;
    try {
      await runProcess(tools.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', wavPath,
        '-af', `atempo=${speed}`, '-ar', String(RATE), '-ac', '1', '-f', 'f32le', temporary], signal);
      checkAbort(signal);
      await fs.promises.rename(temporary, prepared);
    } finally { await fs.promises.rm(temporary, { force: true }); }
  }
  const bytes = (await fs.promises.stat(prepared)).size;
  const durationMs = bytes / (RATE * 4) * 1000;
  if (!bytes || bytes % 4 || durationMs > MAX_DOCUMENTARY_CLIP_MS / speed + 1000) throw new Error('Invalid cached narration audio');
  return { id, path: prepared, durationMs };
}

export async function previewDocumentaryClip(clip: DocumentaryClip, tools: DocumentaryTools, signal?: AbortSignal): Promise<string> {
  const target = `${clip.path}.wav`;
  if (!fs.existsSync(target)) {
    const temporary = `${target}.partial.wav`;
    try {
      await runProcess(tools.ffmpeg, ['-v', 'error', '-nostdin', '-y',
        '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', clip.path, '-c:a', 'pcm_s16le', temporary], signal);
      checkAbort(signal);
      await fs.promises.rename(temporary, target);
    } finally { await fs.promises.rm(temporary, { force: true }); }
  }
  return target;
}

export async function writeDocumentaryNarration(
  file: string, cues: DocumentaryCue[], clips: DocumentaryClip[], originMs: number, durationMs: number, signal?: AbortSignal,
): Promise<void> {
  if (endianness() !== 'LE') throw new Error('This audio mixer requires a little-endian desktop');
  const frames = Math.ceil(durationMs * RATE / 1000);
  const target = await fs.promises.open(file, 'w+');
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  try {
    // A sparse mono timeline avoids materializing hours of silence in RAM.
    await target.truncate(frames * 4);
    for (const cue of cues) {
      checkAbort(signal);
      const clip = byId.get(cue.id);
      if (cue.skip || !clip) continue;
      const offset = Math.round((cue.startMs - originMs) * RATE / 1000);
      const input = await fs.promises.readFile(clip.path);
      const skip = Math.max(0, -offset), position = Math.max(0, offset);
      const length = Math.min(input.length / 4 - skip, frames - position);
      if (length <= 0) continue;
      const mixed = Buffer.alloc(length * 4);
      await target.read(mixed, 0, mixed.length, position * 4);
      for (let i = 0; i < length; i++) mixed.writeFloatLE(mixed.readFloatLE(i * 4) + input.readFloatLE((skip + i) * 4), i * 4);
      await target.write(mixed, 0, mixed.length, position * 4);
    }
  } finally { await target.close(); }
}

/** Uniform ducking for ALL original channels; narration is added to FC only in 5.1. */
export async function mixDocumentaryPcm(
  original: string, narration: string, output: string, channels: number,
  durationMs: number, intervals: Array<{ startMs: number; endMs: number }>,
  settings: DocumentarySettings, signal?: AbortSignal,
): Promise<void> {
  if (![1, 2, 6].includes(channels)) throw new Error('Unsupported mixer channel count');
  if (endianness() !== 'LE') throw new Error('This audio mixer requires a little-endian desktop');
  const handles = await Promise.all([fs.promises.open(original, 'r'), fs.promises.open(narration, 'r'), fs.promises.open(output, 'w')]);
  const [source, voice, target] = handles;
  const total = Math.ceil(durationMs * RATE / 1000);
  const windows = duckIntervals(intervals, settings.attackMs, settings.releaseMs);
  const voiceGain = 10 ** (settings.narrationDb / 20);
  let windowIndex = 0;
  try {
    for (let frame = 0; frame < total; frame += 8192) {
      checkAbort(signal);
      const length = Math.min(8192, total - frame);
      const input = Buffer.alloc(length * channels * 4), dub = Buffer.alloc(length * 4);
      const mixed = Buffer.alloc(input.length);
      await Promise.all([source.read(input, 0, input.length, frame * channels * 4), voice.read(dub, 0, dub.length, frame * 4)]);
      const sourceValues = new Float32Array(input.buffer, input.byteOffset, length * channels);
      const voiceValues = new Float32Array(dub.buffer, dub.byteOffset, length);
      const mixedValues = new Float32Array(mixed.buffer, mixed.byteOffset, length * channels);
      for (let i = 0; i < length; i++) {
        const timeMs = (frame + i) / RATE * 1000;
        while (windows[windowIndex] && timeMs > windows[windowIndex].endMs + settings.releaseMs) windowIndex++;
        const gain = documentaryDuckGain(timeMs, windows[windowIndex], settings);
        for (let channel = 0; channel < channels; channel++) {
          const narrationGain = channels === 6 ? (channel === 2 ? voiceGain : 0)
            : channels === 2 ? voiceGain * Math.SQRT1_2 : voiceGain;
          const k = i * channels + channel;
          mixedValues[k] = sourceValues[k] * gain + voiceValues[i] * narrationGain;
        }
      }
      await target.write(mixed);
    }
  } finally { await Promise.all(handles.map((handle) => handle.close())); }
}

export async function renderDocumentaryAudio(
  source: string, audioStreamIndex: number, media: DocumentaryMedia,
  cues: DocumentaryCue[], clips: DocumentaryClip[], originMs: number, durationMs: number,
  settings: DocumentarySettings, directory: string, tools: DocumentaryTools, signal?: AbortSignal,
): Promise<string> {
  const layout = documentaryLayout(media, audioStreamIndex, settings.layout);
  const original = path.join(directory, 'original.f32'), narration = path.join(directory, 'narration.f32');
  const mixed = path.join(directory, 'mixed.f32'), encoded = path.join(directory, 'dub.mka');
  await runProcess(tools.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-copyts', '-start_at_zero',
    '-i', source, '-map', `0:${audioStreamIndex}`, '-t', String(durationMs / 1000),
    '-af', `aresample=${RATE}:async=1:first_pts=0,aformat=channel_layouts=${layout.name}`,
    '-ac', String(layout.channels), '-ar', String(RATE), '-f', 'f32le', original], signal);
  await writeDocumentaryNarration(narration, cues, clips, originMs, durationMs, signal);
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const intervals = cues.filter((cue) => !cue.skip && byId.has(cue.id)).map((cue) => ({
    startMs: cue.startMs - originMs, endMs: cue.startMs - originMs + byId.get(cue.id)!.durationMs,
  })).filter((interval) => interval.endMs > 0 && interval.startMs < durationMs);
  await mixDocumentaryPcm(original, narration, mixed, layout.channels, durationMs, intervals, settings, signal);
  await fs.promises.rm(original, { force: true });
  const bitrate = layout.channels === 6 ? '640k' : '192k';
  // alimiter prevents clipping without amix's implicit gain normalization.
  await runProcess(tools.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'f32le', '-ar', String(RATE),
    '-ac', String(layout.channels), '-channel_layout', layout.channels === 6 ? '5.1(side)' : layout.name,
    '-i', mixed, '-af', 'alimiter=limit=0.95:level=false:latency=true',
    '-c:a', settings.codec, '-b:a', bitrate, encoded], signal);
  return encoded;
}
