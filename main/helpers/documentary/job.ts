import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  MAX_DOCUMENTARY_CLIP_MS, DOCUMENTARY_RATE, documentaryOverlaps,
  type DocumentaryProject, type DocumentaryMedia, type DocumentaryCue, type DocumentaryClip,
} from '../../../types/documentary';
import { documentarySynthesisKey, synthesizeGemini } from './gemini';
import { checkAbort, runProcess, type DocumentaryTools } from './process';
import { probeDocumentary, preflightDocumentary, documentarySample, muxDocumentary } from './media';
import { documentaryLayout, prepareDocumentaryClip, renderDocumentaryAudio, previewDocumentaryClip } from './audio';

export interface DocumentaryJobContext {
  tools: DocumentaryTools;
  cacheDirectory: string;
  apiKey: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  progress: (stage: string, completed?: number, total?: number, cueId?: string) => void;
}

export async function generateDocumentaryCue(
  cue: DocumentaryCue, project: DocumentaryProject, context: DocumentaryJobContext, force = false,
): Promise<DocumentaryClip> {
  checkAbort(context.signal);
  const key = documentarySynthesisKey(cue.text, project.settings);
  const raw = path.join(context.cacheDirectory, `${key}.raw.wav`);
  await fs.promises.mkdir(context.cacheDirectory, { recursive: true, mode: 0o700 });
  if (force || !fs.existsSync(raw)) {
    const data = await synthesizeGemini(cue.text, project.settings, context.apiKey, context.signal, context.fetcher);
    const temporary = `${raw}.${randomUUID()}.tmp.wav`;
    try {
      await fs.promises.writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
      const info = await probeDocumentary(temporary, context.tools, context.signal);
      if (info.durationMs > MAX_DOCUMENTARY_CLIP_MS) throw new Error(`Cue ${cue.id} exceeds 120 seconds; split it in Review`);
      checkAbort(context.signal);
      await fs.promises.rename(temporary, raw);
    } finally { await fs.promises.rm(temporary, { force: true }); }
  }
  return prepareDocumentaryClip(cue.id, raw, project.settings.speed, context.cacheDirectory, context.tools, context.signal);
}

export async function auditionDocumentaryCue(cue: DocumentaryCue, project: DocumentaryProject, context: DocumentaryJobContext, force = false) {
  const clip = await generateDocumentaryCue(cue, project, context, force);
  return { id: cue.id, durationMs: clip.durationMs, path: await previewDocumentaryClip(clip, context.tools, context.signal) };
}

export interface DocumentaryRenderResult {
  outputPath: string;
  clips: Array<{ id: string; durationMs: number }>;
  overlaps: Array<{ first: string; second: string; overlapMs: number }>;
  originMs: number;
  durationMs: number;
  tailMs: number;
}

export async function renderDocumentary(
  project: DocumentaryProject, media: DocumentaryMedia, outputPath: string,
  sample: { startMs: number; durationMs: number } | undefined, context: DocumentaryJobContext,
): Promise<DocumentaryRenderResult> {
  checkAbort(context.signal);
  const currentSource = await fs.promises.stat(project.mediaPath);
  if (currentSource.size !== project.mediaSize || Math.abs(currentSource.mtimeMs - project.mediaMtimeMs) > 1) {
    throw new Error('Source media changed; reopen it before rendering');
  }
  if (!project.reviewed || !project.cues.length) throw new Error('Approve the subtitle grouping in Review before rendering');
  if (path.extname(outputPath).toLowerCase() !== '.mkv' || fs.existsSync(outputPath)) throw new Error('Choose a new, unused .mkv output file');
  const directory = await fs.promises.mkdtemp(path.join(path.dirname(outputPath), '.smartsub-documentary-'));
  await fs.promises.chmod(directory, 0o700);
  try {
    const { tools, signal } = context;
    context.progress('preflight');
    const layout = documentaryLayout(media, project.audioStreamIndex, project.settings.layout);
    const seconds = (sample ? sample.durationMs + MAX_DOCUMENTARY_CLIP_MS : media.durationMs) / 1000;
    const stats = await fs.promises.statfs(directory);
    const sourceBytes = sample ? Math.min(project.mediaSize, project.mediaSize * seconds / (media.durationMs / 1000)) * 2 : project.mediaSize;
    const required = seconds * DOCUMENTARY_RATE * 4 * (layout.channels * 2 + 1) + sourceBytes + 512 * 1024 * 1024;
    if (stats.bavail * stats.bsize < required) throw new Error(`Insufficient working space; approximately ${Math.ceil(required / 1024 ** 3)} GiB is required on the output volume`);
    await preflightDocumentary(project.mediaPath, directory, tools, signal);
    const encoderCheck = path.join(directory, 'encoder-check.mka');
    await runProcess(tools.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i',
      `anullsrc=r=48000:cl=${layout.channels === 6 ? '5.1(side)' : layout.name}`, '-t', '0.1', '-c:a', project.settings.codec, encoderCheck], signal, 30000);
    let source = project.mediaPath, sourceMedia = media, originMs = 0;
    if (sample) {
      const slice = await documentarySample(source, media, sample.startMs, sample.durationMs, directory, tools, signal);
      source = slice.path; sourceMedia = slice.media; originMs = slice.originMs;
    }
    // A bounded look-behind includes speech crossing the sample's actual keyframe boundary.
    const lookBehind = MAX_DOCUMENTARY_CLIP_MS / project.settings.speed + 1000;
    const selected = project.cues.filter((cue) => !cue.skip && (!sample ||
      (cue.startMs < originMs + sourceMedia.durationMs && cue.startMs + lookBehind > originMs)));
    // Validate every request before spending on the first cue.
    for (const cue of selected) documentarySynthesisKey(cue.text, project.settings);
    const clips: DocumentaryClip[] = [];
    for (const cue of selected) {
      context.progress('synthesis', clips.length, selected.length, cue.id);
      try { clips.push(await generateDocumentaryCue(cue, project, context)); }
      catch (error) { throw new Error(`Cue ${cue.id}: ${error instanceof Error ? error.message : 'Synthesis failed'}`); }
    }
    const overlaps = documentaryOverlaps(selected, clips);
    const byId = new Map(clips.map((clip) => [clip.id, clip]));
    const speechEnd = selected.reduce((end, cue) => Math.max(end, cue.startMs + (byId.get(cue.id)?.durationMs || 0)), 0);
    const durationMs = sample ? sourceMedia.durationMs : Math.max(media.durationMs, speechEnd);
    context.progress('mix', clips.length, selected.length);
    const sourceAudioOrdinal = media.streams.filter((s) => s.codec_type === 'audio').findIndex((s) => s.index === project.audioStreamIndex);
    const mixAudioIndex = sourceMedia.streams.filter((s) => s.codec_type === 'audio')[sourceAudioOrdinal]?.index;
    if (mixAudioIndex === undefined) throw new Error('Selected audio track was not retained in the sample');
    const dubbed = await renderDocumentaryAudio(source, mixAudioIndex, sourceMedia,
      selected, clips, originMs, durationMs, project.settings, directory, tools, signal);
    context.progress('mux');
    const temporaryOutput = path.join(directory, 'output.mkv');
    await muxDocumentary(source, dubbed, temporaryOutput, sourceMedia.streams.filter((s) => s.codec_type === 'audio').length, tools, signal);
    checkAbort(signal);
    // Prefer atomic, no-clobber publication; exFAT and some network volumes lack hard links.
    await publishDocumentaryOutput(temporaryOutput, outputPath);
    context.progress('done', selected.length, selected.length);
    return { outputPath, clips: clips.map(({ id, durationMs: clipDuration }) => ({ id, durationMs: clipDuration })),
      overlaps, originMs, durationMs, tailMs: sample ? 0 : Math.max(0, speechEnd - media.durationMs) };
  } finally {
    // Only our mkdtemp directory is removed; source media and cached successful TTS remain untouched.
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

export async function publishDocumentaryOutput(temporary: string, destination: string): Promise<void> {
  try { await fs.promises.link(temporary, destination); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV'].includes(code || '')) throw error;
    await fs.promises.copyFile(temporary, destination, fs.constants.COPYFILE_EXCL);
  }
}
