/** File-backed, single-narrator voice-over. No credentials belong in this model. */
export interface DocumentaryCue {
  id: string;
  sourceCueIds: number[];
  startMs: number;
  endMs: number;
  text: string;
  skip: boolean;
}

export interface DocumentarySettings {
  model: string;
  voice: string;
  style: string;
  language: string;
  /** Applied once, locally, to every clip; never inferred from subtitle end. */
  speed: number;
  duckDb: number;
  attackMs: number;
  releaseMs: number;
  narrationDb: number;
  layout: 'auto' | 'stereo' | '5.1';
  codec: 'eac3' | 'ac3' | 'aac';
}

export interface DocumentaryProject {
  version: 1;
  id: string;
  revision: number;
  mediaPath: string;
  mediaSize: number;
  mediaMtimeMs: number;
  audioStreamIndex: number;
  subtitleSource: string;
  sourceCues: DocumentaryCue[];
  cues: DocumentaryCue[];
  settings: DocumentarySettings;
  reviewed: boolean;
}

export interface DocumentaryStream {
  index: number;
  codec_type: string;
  codec_name: string;
  channels?: number;
  channel_layout?: string;
  start_time?: string;
  tags?: Record<string, string>;
}

export interface DocumentaryMedia {
  streams: DocumentaryStream[];
  durationMs: number;
  startMs: number;
}

export interface DocumentaryClip {
  id: string;
  path: string;
  durationMs: number;
}

export interface DocumentarySnapshot {
  sessionId: string;
  project: DocumentaryProject;
  media: DocumentaryMedia;
  projectPath: string;
}

export interface DocumentaryProgress {
  sessionId: string;
  stage: string;
  completed?: number;
  total?: number;
  cueId?: string;
}

export const MAX_DOCUMENTARY_CLIP_MS = 120000;
export const DOCUMENTARY_RATE = 48000;

export const DOCUMENTARY_PRESETS = [
  {
    id: 'nature',
    name: 'Nature documentary',
    voice: 'Charon',
    style: 'Calm, warm, mature nature-documentary narration. Measured and even delivery, subtle wonder, restrained rather than theatrical. Keep a consistent voice and pace.',
  },
  {
    id: 'calm',
    name: 'Calm documentary',
    voice: 'Schedar',
    style: 'Neutral, clear, even documentary narration. Steady conversational pace, restrained emotion and consistent volume.',
  },
  {
    id: 'dramatic',
    name: 'Dramatic prehistory',
    voice: 'Algenib',
    style: 'Mature cinematic documentary narration. Subtle suspense and gravitas, without shouting, sound effects, or exaggerated acting. Keep a steady pace.',
  },
  {
    id: 'children',
    name: 'Children’s documentary',
    voice: 'Sulafat',
    style: 'Warm, friendly and curious documentary narration for children. Clear Czech pronunciation, gentle enthusiasm, not cartoonish. Keep a steady pace.',
  },
] as const;

export const DOCUMENTARY_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

export function defaultDocumentarySettings(): DocumentarySettings {
  return {
    model: 'gemini-3.8-flash-tts',
    voice: 'Charon',
    style: DOCUMENTARY_PRESETS[0].style,
    language: 'cs-CZ',
    speed: 1,
    duckDb: -12,
    attackMs: 200,
    releaseMs: 350,
    narrationDb: 0,
    layout: 'auto',
    codec: 'eac3',
  };
}

const inRange = (n: number, min: number, max: number) =>
  Number.isFinite(n) && n >= min && n <= max;

export function assertDocumentarySettings(
  value: unknown,
): asserts value is DocumentarySettings {
  const s = value as DocumentarySettings | null;
  if (!s || !/^gemini-[a-zA-Z0-9.-]*tts[a-zA-Z0-9.-]*$/.test(s.model) ||
      typeof s.voice !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(s.voice) ||
      typeof s.style !== 'string' || s.style.length > 3000 ||
      typeof s.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(s.language) ||
      !inRange(s.speed, 0.5, 2) || !inRange(s.duckDb, -60, 0) ||
      !inRange(s.narrationDb, -30, 12) || !inRange(s.attackMs, 0, 3000) ||
      !inRange(s.releaseMs, 0, 5000) || !['auto', 'stereo', '5.1'].includes(s.layout) ||
      !['eac3', 'ac3', 'aac'].includes(s.codec)) {
    throw new Error('Invalid documentary voice or mix settings');
  }
}

export function assertDocumentaryCues(value: unknown): asserts value is DocumentaryCue[] {
  if (!Array.isArray(value) || value.length > 50000) throw new Error('Invalid cue list');
  const ids = new Set<string>();
  for (const cue of value as DocumentaryCue[]) {
    if (!cue || typeof cue.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(cue.id) ||
        ids.has(cue.id) || !inRange(cue.startMs, 0, 43200000) ||
        !inRange(cue.endMs, cue.startMs, 43200000) ||
        typeof cue.text !== 'string' || cue.text.length > 12000 ||
        (!cue.skip && !cue.text.trim()) || typeof cue.skip !== 'boolean' ||
        !Array.isArray(cue.sourceCueIds) ||
        !cue.sourceCueIds.every((id) => Number.isInteger(id) && id >= 0)) {
      throw new Error('Invalid cue: check IDs, text and non-negative times');
    }
    ids.add(cue.id);
  }
}

export function cleanDocumentaryText(text: string): string {
  const entities: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  };
  return text.replace(/\{[^}]*\}/g, '').replace(/<[^>]*>/g, '')
    .replace(/\\[Nnh]/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? all;
      const code = entity[1].toLowerCase() === 'x'
        ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : all;
    }).replace(/\s+/g, ' ').trim();
}

/** Conservative proposal. Speaker changes and punctuation are review boundaries. */
export function groupDocumentaryCues(
  source: DocumentaryCue[],
  maxGapMs = 500,
  maxSpanMs = 15000,
): DocumentaryCue[] {
  assertDocumentaryCues(source);
  const result: DocumentaryCue[] = [];
  for (const cue of [...source].sort((a, b) => a.startMs - b.startMs)) {
    const next = { ...cue, sourceCueIds: [...cue.sourceCueIds], text: cleanDocumentaryText(cue.text) };
    next.skip = next.skip || !next.text || /^(?:\[[^\]]+\]|[♪♫].*)$/.test(next.text);
    const previous = result[result.length - 1];
    const terminal = previous && /[.!?…]["'”’»)]*$/.test(previous.text) &&
      !/(?:např|tzv|atd|apod|Dr|Mr|Mrs)\.$/i.test(previous.text);
    const speakerBoundary = /^[-–—]\s|^[^:]{1,25}:/.test(next.text) ||
      (previous && /^[-–—]\s|^[^:]{1,25}:/.test(previous.text));
    if (previous && !previous.skip && !next.skip && !terminal && !speakerBoundary &&
        next.startMs >= previous.endMs && next.startMs - previous.endMs <= maxGapMs &&
        next.endMs - previous.startMs <= maxSpanMs) {
      previous.text += ` ${next.text}`;
      previous.endMs = next.endMs;
      previous.sourceCueIds = [...new Set([...previous.sourceCueIds, ...next.sourceCueIds])];
    } else result.push(next);
  }
  return result;
}

export function mergeDocumentaryCues(cues: DocumentaryCue[], index: number): DocumentaryCue[] {
  if (!cues[index] || !cues[index + 1]) throw new Error('Select two adjacent cues');
  const a = cues[index], b = cues[index + 1];
  const merged: DocumentaryCue = {
    ...a, startMs: Math.min(a.startMs, b.startMs), endMs: Math.max(a.endMs, b.endMs),
    text: `${a.text} ${b.text}`.trim(), skip: a.skip && b.skip,
    sourceCueIds: [...new Set([...a.sourceCueIds, ...b.sourceCueIds])],
  };
  return [...cues.slice(0, index), merged, ...cues.slice(index + 2)];
}

export function splitDocumentaryCue(
  cues: DocumentaryCue[], index: number, character: number, splitMs: number, newId: string,
): DocumentaryCue[] {
  const cue = cues[index];
  if (!cue || character <= 0 || character >= cue.text.length ||
      splitMs <= cue.startMs || splitMs >= cue.endMs) throw new Error('Choose a split inside the text and time range');
  const left = { ...cue, text: cue.text.slice(0, character).trim(), endMs: splitMs };
  const right = { ...cue, id: newId, text: cue.text.slice(character).trim(), startMs: splitMs };
  if (!left.text || !right.text) throw new Error('Both split cues need text');
  return [...cues.slice(0, index), left, right, ...cues.slice(index + 1)];
}

export interface DocumentaryInterval { startMs: number; endMs: number }

export function documentaryOverlaps(
  cues: DocumentaryCue[], clips: DocumentaryClip[],
): Array<{ first: string; second: string; overlapMs: number }> {
  const lengths = new Map(clips.map((c) => [c.id, c.durationMs]));
  const sorted = cues.filter((c) => !c.skip && lengths.has(c.id)).sort((a, b) => a.startMs - b.startMs);
  const result: Array<{ first: string; second: string; overlapMs: number }> = [];
  // Bound diagnostics for malformed subtitles with thousands of coincident cues.
  for (let i = 0; i < sorted.length && result.length < 10000; i++) {
    const end = sorted[i].startMs + lengths.get(sorted[i].id)!;
    for (let j = i + 1; j < sorted.length && sorted[j].startMs < end && result.length < 10000; j++) {
      result.push({ first: sorted[i].id, second: sorted[j].id,
        overlapMs: Math.min(end, sorted[j].startMs + lengths.get(sorted[j].id)!) - sorted[j].startMs });
    }
  }
  return result;
}

/** Merge nearby speech intervals so short pauses do not pump the original mix. */
export function duckIntervals(intervals: DocumentaryInterval[], attackMs: number, releaseMs: number): DocumentaryInterval[] {
  const result: DocumentaryInterval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.startMs - b.startMs)) {
    const last = result[result.length - 1];
    if (last && interval.startMs - attackMs <= last.endMs + releaseMs) last.endMs = Math.max(last.endMs, interval.endMs);
    else result.push({ ...interval });
  }
  return result;
}

export function documentaryDuckGain(timeMs: number, interval: DocumentaryInterval | undefined, settings: DocumentarySettings): number {
  if (!interval) return 1;
  const { startMs, endMs } = interval;
  let fraction = 0;
  if (timeMs >= startMs && timeMs <= endMs) fraction = 1;
  else if (timeMs < startMs && settings.attackMs > 0) fraction = Math.max(0, 1 - (startMs - timeMs) / settings.attackMs);
  else if (timeMs > endMs && settings.releaseMs > 0) fraction = Math.max(0, 1 - (timeMs - endMs) / settings.releaseMs);
  return 10 ** (settings.duckDb * fraction / 20);
}
