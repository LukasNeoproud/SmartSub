import { app, BrowserWindow, dialog, ipcMain, net, shell, type IpcMainInvokeEvent } from 'electron';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  assertDocumentaryCues, assertDocumentarySettings, defaultDocumentarySettings, groupDocumentaryCues,
  type DocumentaryProject, type DocumentarySettings, type DocumentarySnapshot, type DocumentaryCue,
} from '../../../types/documentary';
import { detectSubtitleFormatFromContent, parseSubtitleCues } from '../subtitleFormats';
import { extractDocumentarySubtitles, importedDocumentaryCues, probeDocumentary } from './media';
import { auditionDocumentaryCue, renderDocumentary, type DocumentaryJobContext } from './job';
import type { DocumentaryTools } from './process';

interface Session { snapshot: DocumentarySnapshot; owner: number; apiKey: string; controller?: AbortController }
const sessions = new Map<string, Session>();

function tools(): DocumentaryTools {
  const ffmpeg = process.env.SMARTSUB_FFMPEG_PATH || ffmpegStatic?.replace('app.asar', 'app.asar.unpacked') || 'ffmpeg';
  const candidate = process.env.SMARTSUB_FFPROBE_PATH ||
    [path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
      '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'].find((file) => fs.existsSync(file));
  return { ffmpeg, ffprobe: candidate || 'ffprobe' };
}

const root = () => path.join(app.getPath('userData'), 'documentary');
const projectPath = (id: string) => path.join(root(), 'projects', `${id}.json`);

function safeCues(cues: DocumentaryCue[]): DocumentaryCue[] {
  assertDocumentaryCues(cues);
  return cues.map(({ id, sourceCueIds, startMs, endMs, text, skip }) => ({ id, sourceCueIds, startMs, endMs, text, skip }));
}
function safeSettings(settings: DocumentarySettings): DocumentarySettings {
  // Migrate projects created by the first documentary-mode build. Only the new voice-profile
  // fields receive defaults; missing/invalid legacy core settings still fail validation below.
  const input = settings as Partial<DocumentarySettings>;
  const normalized = {
    ...settings,
    voiceSource: input.voiceSource ?? 'prebuilt',
    voiceProfileName: input.voiceProfileName ?? '',
    customVoiceId: input.customVoiceId ?? '',
  } as DocumentarySettings;
  assertDocumentarySettings(normalized);
  // Whitelist so exported JSON can never acquire an API key or arbitrary provider data.
  return Object.fromEntries(Object.keys(defaultDocumentarySettings()).map((key) =>
    [key, normalized[key as keyof DocumentarySettings]])) as unknown as DocumentarySettings;
}
function safeProject(value: any): DocumentaryProject {
  if (!value || value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id) ||
      typeof value.mediaPath !== 'string' || !path.isAbsolute(value.mediaPath) ||
      !Number.isFinite(value.mediaSize) || value.mediaSize <= 0 || !Number.isFinite(value.mediaMtimeMs) ||
      !Number.isInteger(value.revision) || value.revision < 0 || !Number.isInteger(value.audioStreamIndex) ||
      typeof value.reviewed !== 'boolean' || typeof value.subtitleSource !== 'string') throw new Error('Invalid documentary project');
  return { version: 1, id: value.id, revision: value.revision, mediaPath: value.mediaPath,
    mediaSize: value.mediaSize, mediaMtimeMs: value.mediaMtimeMs, audioStreamIndex: value.audioStreamIndex,
    subtitleSource: value.subtitleSource, sourceCues: safeCues(value.sourceCues), cues: safeCues(value.cues),
    settings: safeSettings(value.settings), reviewed: value.reviewed };
}
async function persist(project: DocumentaryProject, destination = projectPath(project.id)): Promise<void> {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.partial`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(safeProject(project), null, 2), { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, destination);
  } finally { await fs.promises.rm(temporary, { force: true }); }
}
function trusted(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted IPC frame');
  const url = new URL(event.senderFrame.url);
  if (url.protocol !== 'app:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Untrusted IPC origin');
}
function sessionFor(event: IpcMainInvokeEvent, id: string, allowBusy = false): Session {
  const session = sessions.get(id);
  if (!session || session.owner !== event.sender.id) throw new Error('Documentary session is not owned by this window');
  if (session.controller && !allowBusy) throw new Error('Wait for the running operation or cancel it before editing');
  return session;
}
async function openFiles(event: IpcMainInvokeEvent, options: Electron.OpenDialogOptions) {
  const parent = BrowserWindow.fromWebContents(event.sender);
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}
async function saveFile(event: IpcMainInvokeEvent, options: Electron.SaveDialogOptions) {
  const parent = BrowserWindow.fromWebContents(event.sender);
  return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
}
async function attach(event: IpcMainInvokeEvent, project: DocumentaryProject): Promise<DocumentarySnapshot> {
  const existing = [...sessions.values()].find((session) => session.snapshot.project.id === project.id);
  if (existing) {
    if (existing.owner !== event.sender.id || existing.controller) throw new Error('This project is already open in another window or is busy');
    return existing.snapshot;
  }
  const stat = await fs.promises.stat(project.mediaPath);
  if (stat.size !== project.mediaSize || Math.abs(stat.mtimeMs - project.mediaMtimeMs) > 1) throw new Error('The source media changed; import it again before reusing subtitle timing');
  const media = await probeDocumentary(project.mediaPath, tools());
  const snapshot = { sessionId: randomUUID(), project, media, projectPath: projectPath(project.id) };
  sessions.set(snapshot.sessionId, { snapshot, owner: event.sender.id, apiKey: '' });
  event.sender.once('destroyed', () => {
    for (const [id, session] of sessions) if (session.owner === event.sender.id) { session.controller?.abort(); sessions.delete(id); }
  });
  await persist(project);
  return snapshot;
}
async function operation<T>(event: IpcMainInvokeEvent, id: string, run: (session: Session, context: DocumentaryJobContext) => Promise<T>): Promise<T> {
  const session = sessionFor(event, id);
  const controller = new AbortController();
  session.controller = controller;
  try {
    return await run(session, {
      tools: tools(), cacheDirectory: path.join(root(), 'cache', session.snapshot.project.id),
      apiKey: session.apiKey || process.env.GEMINI_API_KEY || '', signal: controller.signal,
      fetcher: ((input: string | URL | Request, init?: RequestInit) => net.fetch(input as string, init)) as typeof fetch,
      progress: (stage, completed, total, cueId) => {
        if (!event.sender.isDestroyed()) event.sender.send('documentary:progress', { sessionId: id, stage, completed, total, cueId });
      },
    });
  } finally { session.controller = undefined; }
}

export function shutdownDocumentary(): void {
  for (const session of sessions.values()) { session.controller?.abort(); session.apiKey = ''; }
}

export function setupDocumentaryHandlers(): void {
  const handle = (name: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown> | unknown) =>
    ipcMain.handle(`documentary:${name}`, (event, ...args) => { trusted(event); return handler(event, ...args); });

  handle('open-media', async (event) => {
    const result = await openFiles(event, { properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mkv', 'mp4', 'm4v', 'mov', 'webm', 'avi', 'ts', 'mts', 'm2ts'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const mediaPath = result.filePaths[0];
    const media = await probeDocumentary(mediaPath, tools());
    const audio = media.streams.find((stream) => stream.codec_type === 'audio');
    if (!audio || !media.streams.some((stream) => stream.codec_type === 'video')) throw new Error('Select a video with an original audio track');
    const stat = await fs.promises.stat(mediaPath);
    return attach(event, { version: 1, id: randomUUID(), revision: 0, mediaPath, mediaSize: stat.size,
      mediaMtimeMs: stat.mtimeMs, audioStreamIndex: audio.index, subtitleSource: '', sourceCues: [], cues: [],
      settings: defaultDocumentarySettings(), reviewed: false });
  });
  handle('open-project', async (event, recentId?: string) => {
    let file: string;
    if (recentId) {
      if (!/^[a-f0-9-]{36}$/.test(recentId)) throw new Error('Invalid project ID');
      file = projectPath(recentId);
    } else {
      const result = await openFiles(event, { properties: ['openFile'], filters: [{ name: 'Documentary project', extensions: ['json'] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      file = result.filePaths[0];
    }
    if ((await fs.promises.stat(file)).size > 16 * 1024 * 1024) throw new Error('Project JSON is too large');
    return attach(event, safeProject(JSON.parse(await fs.promises.readFile(file, 'utf8'))));
  });
  handle('recent', async () => {
    const folder = path.join(root(), 'projects');
    if (!fs.existsSync(folder)) return [];
    const files = (await fs.promises.readdir(folder)).filter((file) => /^[a-f0-9-]{36}\.json$/.test(file));
    const recent = await Promise.all(files.map(async (file) => ({ file, time: (await fs.promises.stat(path.join(folder, file))).mtimeMs })));
    const result: Array<{ id: string; name: string }> = [];
    for (const item of recent.sort((a, b) => b.time - a.time).slice(0, 10)) {
      try { const p = safeProject(JSON.parse(await fs.promises.readFile(path.join(folder, item.file), 'utf8'))); result.push({ id: p.id, name: path.basename(p.mediaPath) }); }
      catch { /* A corrupt project is not silently replaced or deleted. */ }
    }
    return result;
  });
  handle('subtitles', (event, id: string, source: 'external' | number) => operation(event, id, async (session, context) => {
    let text: string, sourceLabel: string;
    if (source === 'external') {
      const result = await openFiles(event, { properties: ['openFile'], filters: [{ name: 'Text subtitles (UTF-8)', extensions: ['srt', 'ass', 'ssa', 'vtt'] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      sourceLabel = result.filePaths[0];
      if ((await fs.promises.stat(sourceLabel)).size > 16 * 1024 * 1024) throw new Error('Subtitle file is too large');
      text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.promises.readFile(sourceLabel));
    } else {
      if (!Number.isInteger(source)) throw new Error('Invalid subtitle stream');
      text = await extractDocumentarySubtitles(session.snapshot.project.mediaPath, source, session.snapshot.media, context.tools, context.signal);
      sourceLabel = `embedded-${source}.srt`;
    }
    const sourceCues = importedDocumentaryCues(parseSubtitleCues(text, detectSubtitleFormatFromContent(sourceLabel, text), { strict: true }));
    if (!sourceCues.length) throw new Error('No timed text subtitles were found');
    const project = { ...session.snapshot.project, sourceCues, cues: groupDocumentaryCues(sourceCues),
      subtitleSource: sourceLabel, reviewed: false, revision: session.snapshot.project.revision + 1 };
    await persist(project);
    session.snapshot = { ...session.snapshot, project };
    return session.snapshot;
  }));
  handle('save', (event, id: string, proposed: DocumentaryProject) => operation(event, id, async (session) => {
    if (proposed.revision !== session.snapshot.project.revision) throw new Error('Project changed; reload before saving');
    if (!session.snapshot.media.streams.some((stream) => stream.index === proposed.audioStreamIndex && stream.codec_type === 'audio')) throw new Error('Invalid source audio track');
    const project = { ...session.snapshot.project, cues: safeCues(proposed.cues), settings: safeSettings(proposed.settings),
      audioStreamIndex: proposed.audioStreamIndex, reviewed: proposed.reviewed === true, revision: proposed.revision + 1 };
    await persist(project);
    session.snapshot = { ...session.snapshot, project };
    return session.snapshot;
  }));
  handle('export-project', async (event, id: string) => {
    const session = sessionFor(event, id);
    const result = await saveFile(event, { defaultPath: `${session.snapshot.project.mediaPath}.voiceover.json`, filters: [{ name: 'Project JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return null;
    if (path.extname(result.filePath).toLowerCase() !== '.json') throw new Error('Use a .json project filename');
    await persist(session.snapshot.project, result.filePath);
    return result.filePath;
  });
  handle('api-key', (event, id: string, key: string) => {
    if (typeof key !== 'string' || key.length > 512) throw new Error('Invalid API key');
    sessionFor(event, id).apiKey = key.trim();
    return true;
  });
  handle('audition', (event, id: string, cueId: string, force: boolean) => operation(event, id, async (session, context) => {
    const cue = session.snapshot.project.cues.find((c) => c.id === cueId && !c.skip);
    if (!cue) throw new Error('Select an active cue');
    return auditionDocumentaryCue(cue, session.snapshot.project, context, force === true);
  }));
  handle('render', (event, id: string, sample?: { startMs: number; durationMs: number }) => operation(event, id, async (session, context) => {
    const project = session.snapshot.project;
    const result = await saveFile(event, { defaultPath: path.join(path.dirname(project.mediaPath),
      `${path.parse(project.mediaPath).name}.cs-voiceover${sample ? '.sample' : ''}.mkv`), filters: [{ name: 'Matroska', extensions: ['mkv'] }] });
    if (result.canceled || !result.filePath) return null;
    return renderDocumentary(project, session.snapshot.media, result.filePath, sample, context);
  }));
  handle('cancel', (event, id: string) => { sessionFor(event, id, true).controller?.abort(); return true; });
  handle('show-project', (event, id: string) => { shell.showItemInFolder(sessionFor(event, id).snapshot.projectPath); });
}
