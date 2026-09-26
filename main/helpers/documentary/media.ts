import fs from 'fs';
import path from 'path';
import type { DocumentaryCue, DocumentaryMedia } from '../../../types/documentary';
import { runProcess, type DocumentaryTools } from './process';

export async function probeDocumentary(file: string, tools: DocumentaryTools, signal?: AbortSignal): Promise<DocumentaryMedia> {
  const raw = await runProcess(tools.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], signal, 30000);
  const result = JSON.parse(raw);
  const durationMs = Number(result.format?.duration) * 1000;
  if (!Array.isArray(result.streams) || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 43200000) {
    throw new Error('Could not determine a finite media duration (maximum 12 hours)');
  }
  return { streams: result.streams, durationMs, startMs: Number(result.format?.start_time || 0) * 1000 };
}

/** Fail before API spending rather than silently dropping unsupported source streams. */
export async function preflightDocumentary(source: string, directory: string, tools: DocumentaryTools, signal?: AbortSignal): Promise<void> {
  const out = path.join(directory, 'preflight.mkv');
  try {
    await runProcess(tools.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-i', source,
      '-t', '0.1', '-map', '0', '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy', out], signal, 30000);
  } finally { await fs.promises.rm(out, { force: true }); }
}

/** Copy-cut at a decodable boundary, then normalize once to discover the true origin. */
export async function documentarySample(
  source: string, media: DocumentaryMedia, startMs: number, durationMs: number,
  directory: string, tools: DocumentaryTools, signal?: AbortSignal,
): Promise<{ path: string; originMs: number; media: DocumentaryMedia }> {
  if (!Number.isFinite(startMs) || startMs < 0 || startMs >= media.durationMs ||
      !Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 300000) throw new Error('Invalid sample range (1–300 seconds)');
  const copy = path.join(directory, 'sample-copy.mkv');
  const normalized = path.join(directory, 'sample-source.mkv');
  const end = Math.min(media.durationMs, startMs + durationMs);
  await runProcess(tools.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-ss', String(startMs / 1000),
    '-copyts', '-start_at_zero', '-i', source, '-to', String(end / 1000),
    '-map', '0', '-map_metadata', '0', '-map_chapters', '-1', '-c', 'copy',
    '-avoid_negative_ts', 'disabled', copy], signal);
  const cut = await probeDocumentary(copy, tools, signal);
  const originMs = Math.max(0, cut.startMs);
  await runProcess(tools.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-i', copy,
    '-map', '0', '-map_metadata', '0', '-c', 'copy', normalized], signal);
  await fs.promises.rm(copy, { force: true });
  return { path: normalized, originMs, media: await probeDocumentary(normalized, tools, signal) };
}

export async function extractDocumentarySubtitles(
  source: string, streamIndex: number, media: DocumentaryMedia, tools: DocumentaryTools, signal?: AbortSignal,
): Promise<string> {
  const stream = media.streams.find((s) => s.index === streamIndex && s.codec_type === 'subtitle');
  if (!stream || !['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'].includes(stream.codec_name)) {
    throw new Error('Choose a text subtitle track. PGS/VobSub are images; supply an external SRT/ASS/VTT instead.');
  }
  return runProcess(tools.ffmpeg, ['-v', 'error', '-nostdin', '-i', source,
    '-map', `0:${streamIndex}`, '-f', 'srt', 'pipe:1'], signal, 120000);
}

export function importedDocumentaryCues(
  cues: Array<{ startMs: number; endMs: number; text: string }>,
): DocumentaryCue[] {
  return cues.map((cue, index) => ({ ...cue, id: `cue-${index}`, sourceCueIds: [index], skip: false }));
}

export async function muxDocumentary(
  source: string, dubbed: string, output: string, audioCount: number,
  tools: DocumentaryTools, signal?: AbortSignal,
): Promise<void> {
  await runProcess(tools.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-i', source, '-i', dubbed,
    '-map', '0', '-map', '1:a:0', '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy',
    `-metadata:s:a:${audioCount}`, 'language=ces', `-metadata:s:a:${audioCount}`, 'title=Čeština — documentary voice-over',
    `-disposition:a:${audioCount}`, '0', output], signal);
  const result = await probeDocumentary(output, tools, signal);
  const original = await probeDocumentary(source, tools, signal);
  // Matroska writes attachments after ordinary tracks even when -map preserves their input order.
  const before = original.streams.filter((s) => s.codec_type !== 'attachment');
  const after = result.streams.filter((s) => s.codec_type !== 'attachment');
  const attachments = (value: DocumentaryMedia) => value.streams.filter((s) => s.codec_type === 'attachment')
    .map((s) => `${s.codec_name}:${s.tags?.filename}:${s.tags?.mimetype}`).sort();
  if (result.streams.length !== original.streams.length + 1 || after.length !== before.length + 1 ||
      before.some((s, i) => after[i]?.codec_type !== s.codec_type || after[i]?.codec_name !== s.codec_name) ||
      after[after.length - 1]?.codec_type !== 'audio' ||
      JSON.stringify(attachments(original)) !== JSON.stringify(attachments(result))) {
    throw new Error('Output validation failed: original stream inventory changed');
  }
}
