/** Local tests only: synthetic media and a fake Google response, never billable API calls. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import {
  defaultDocumentarySettings, groupDocumentaryCues, mergeDocumentaryCues, splitDocumentaryCue,
  assertDocumentarySettings, assertDocumentaryCues, documentaryOverlaps, documentaryDuckGain,
  duckIntervals, effectiveDocumentaryVoice, type DocumentaryCue, type DocumentaryProject,
} from '../../types/documentary';
import { geminiRequest, documentarySynthesisKey, decodeGeminiAudio, synthesizeGemini } from '../../main/helpers/documentary/gemini';
import { mixDocumentaryPcm, writeDocumentaryNarration } from '../../main/helpers/documentary/audio';
import { runProcess } from '../../main/helpers/documentary/process';
import { probeDocumentary, extractDocumentarySubtitles } from '../../main/helpers/documentary/media';
import { renderDocumentary, generateDocumentaryCue, publishDocumentaryOutput } from '../../main/helpers/documentary/job';

const settings = defaultDocumentarySettings();
const tools = { ffmpeg: process.env.SMARTSUB_FFMPEG_PATH || 'ffmpeg', ffprobe: process.env.SMARTSUB_FFPROBE_PATH || 'ffprobe' };
const cue = (id: string, startMs: number, endMs: number, text: string): DocumentaryCue => ({ id, startMs, endMs, text, sourceCueIds: [Number(id.replace(/\D/g, '')) || 0], skip: false });
const close = (actual: number, expected: number, tolerance = 0.00001) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'smartsub-documentary-test-'));
  try { await run(dir); } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}
function floatPcm(frames: number, channels: number, value: number): Buffer {
  const bytes = Buffer.alloc(frames * channels * 4);
  for (let n = 0; n < frames * channels; n++) bytes.writeFloatLE(value, n * 4);
  return bytes;
}
function wav(durationMs = 1200): Buffer {
  const data = Buffer.alloc(24000 * 2 * durationMs / 1000);
  for (let i = 0; i < data.length / 2; i++) data.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 500 * i / 24000)), i * 2);
  return decodeGeminiAudio({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: data.toString('base64') } }] } }] });
}
const response = (data: Buffer) => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: data.toString('base64') } }] } }] }), { status: 200 });

test('grouping is conservative, preserves provenance and never mutates original cues', () => {
  const original = [cue('a0', 0, 1000, '<i>Před miliony let</i>'), cue('a1', 1050, 2500, 'zde žili obři.'), cue('a2', 2600, 3000, 'Jiná věta.'), cue('a3', 3000, 3500, '[řev]')];
  const snapshot = structuredClone(original);
  const grouped = groupDocumentaryCues(original);
  assert.equal(grouped.length, 3); assert.equal(grouped[0].text, 'Před miliony let zde žili obři.');
  assert.deepEqual(grouped[0].sourceCueIds, [0, 1]); assert.equal(grouped[2].skip, true);
  assert.deepEqual(original, snapshot);
  assert.equal(groupDocumentaryCues([cue('a', 0, 1000, '- Ahoj'), cue('b', 1000, 2000, '- Nazdar')]).length, 2);
  assert.equal(groupDocumentaryCues([cue('a', 0, 1000, 'Začátek'), cue('b', 800, 2000, 'překryv')]).length, 2);
  assert.equal(groupDocumentaryCues([cue('a', 0, 1000, 'Začátek'), cue('b', 1800, 2000, 'po pauze')]).length, 2);
});
test('manual merge and split preserve source IDs and require explicit valid boundaries', () => {
  const a = [cue('a0', 0, 1000, 'Stádo'), cue('a1', 1000, 2000, 'odchází.')];
  const joined = mergeDocumentaryCues(a, 0);
  const split = splitDocumentaryCue(joined, 0, 5, 950, 'b');
  assert.equal(split.length, 2); assert.equal(split[1].startMs, 950);
  assert.deepEqual(split[0].sourceCueIds, [0, 1]); assert.deepEqual(split[1].sourceCueIds, [0, 1]);
  assert.throws(() => splitDocumentaryCue(joined, 0, 0, 950, 'b'));
  assert.throws(() => splitDocumentaryCue(joined, 0, 5, 2200, 'b'));
});
test('settings/cue validation rejects invalid speed, voice IDs, times and duplicate IDs', () => {
  assertDocumentarySettings(settings); assert.throws(() => assertDocumentarySettings({ ...settings, speed: NaN }));
  const custom = { ...settings, voiceSource: 'custom' as const, voiceProfileName: 'CZ Documentary', customVoiceId: 'voice_test_1234' };
  assertDocumentarySettings(custom); assert.equal(effectiveDocumentaryVoice(custom), 'voice_test_1234');
  assert.throws(() => assertDocumentarySettings({ ...custom, customVoiceId: 'not-a-designed-voice' }));
  assert.throws(() => assertDocumentaryCues([cue('x', -1, 1, 'A')]));
  assert.throws(() => assertDocumentaryCues([cue('x', 0, 1, 'A'), cue('x', 1, 2, 'B')]));
});
test('start-only overlap checks measured audio, not subtitle ends, without moving cues', () => {
  const cues = [cue('a', 1000, 1200, 'A'), cue('b', 1700, 2500, 'B')];
  const before = structuredClone(cues);
  assert.deepEqual(documentaryOverlaps(cues, [{ id: 'a', durationMs: 1200, path: '' }, { id: 'b', durationMs: 400, path: '' }]), [{ first: 'a', second: 'b', overlapMs: 400 }]);
  assert.deepEqual(cues, before);
});
test('duck envelope has attack/release and merges close intervals', () => {
  const interval = { startMs: 1000, endMs: 2000 };
  close(documentaryDuckGain(700, interval, settings), 1);
  close(documentaryDuckGain(1000, interval, settings), 10 ** (-12 / 20));
  close(documentaryDuckGain(900, interval, settings), 10 ** (-6 / 20));
  close(documentaryDuckGain(2350, interval, settings), 1);
  assert.deepEqual(duckIntervals([interval, { startMs: 2300, endMs: 2600 }], 200, 350), [{ startMs: 1000, endMs: 2600 }]);
});
test('Gemini payload uses structured 3.8 and legacy voice contracts; cache ignores speed/mix', () => {
  const modern = geminiRequest('Zde žili dinosauři.', settings) as any;
  assert.equal(modern.contents[0].parts[0].text, 'Zde žili dinosauři.');
  assert.ok(modern.contents[0].parts[0].speech_metadata.style);
  assert.equal(modern.generationConfig.speechConfig.voiceConfig.voice, 'Charon');
  const legacy = geminiRequest('Text.', { ...settings, model: 'gemini-2.5-pro-preview-tts' }) as any;
  assert.equal(legacy.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
  const key = documentarySynthesisKey('A', settings);
  assert.equal(key, documentarySynthesisKey('A', { ...settings, speed: 1.2, duckDb: -20 }));
  assert.notEqual(key, documentarySynthesisKey('A', { ...settings, voice: 'Kore' }));
  const designed = { ...settings, voiceSource: 'custom' as const, voiceProfileName: 'Local label', customVoiceId: 'voice_test_1234' };
  const designedRequest = geminiRequest('A', designed) as any;
  assert.equal(designedRequest.generationConfig.speechConfig.voiceConfig.voice, 'voice_test_1234');
  assert.equal(documentarySynthesisKey('A', designed), documentarySynthesisKey('A', { ...designed, voiceProfileName: 'Renamed locally' }));
  assert.notEqual(documentarySynthesisKey('A', designed), documentarySynthesisKey('A', { ...designed, customVoiceId: 'voice_test_5678' }));
  assert.throws(() => geminiRequest('A', { ...designed, model: 'gemini-2.5-pro-preview-tts' }));
  assert.notEqual(key, documentarySynthesisKey('B', settings));
  assert.throws(() => geminiRequest('á'.repeat(2001), settings));
});
test('Google audio decoder accepts WAV/legacy PCM and rejects truncated responses', () => {
  const audio = wav(); assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.deepEqual(decodeGeminiAudio({ candidates: [{ content: { parts: [{ inlineData: { data: audio.toString('base64') } }] } }] }), audio);
  assert.throws(() => decodeGeminiAudio({ candidates: [{ finishReason: 'MAX_TOKENS' }] }));
  assert.throws(() => decodeGeminiAudio({ candidates: [] }));
});
test('Google adapter retries quota once, never exposes keys, and cancels', async () => {
  let calls = 0;
  const fake = (async (_url: unknown, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>)['x-goog-api-key'], 'test-secret');
    return ++calls === 1 ? new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }) : response(wav());
  }) as typeof fetch;
  await synthesizeGemini('A', settings, 'test-secret', undefined, fake); assert.equal(calls, 2);
  await assert.rejects(() => synthesizeGemini('A', settings, 'test-secret', undefined, (async () => new Response('test-secret', { status: 403 })) as typeof fetch), (e: any) => e.message.includes('403') && !e.message.includes('test-secret'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => synthesizeGemini('A', settings, 'test-secret', controller.signal, fake), { name: 'AbortError' });
});
test('sparse narration uses exact starts, mixes overlaps and crops boundary-crossing speech', async () => temporary(async (dir) => {
  const clip = path.join(dir, 'clip.f32'); await fs.promises.writeFile(clip, floatPcm(48000, 1, 0.2));
  const output = path.join(dir, 'timeline.f32');
  await writeDocumentaryNarration(output, [cue('a', 500, 600, 'A'), cue('b', 1000, 1100, 'B')],
    [{ id: 'a', path: clip, durationMs: 1000 }, { id: 'b', path: clip, durationMs: 1000 }], 0, 2500);
  const data = await fs.promises.readFile(output); const value = (seconds: number) => data.readFloatLE(Math.round(seconds * 48000) * 4);
  close(value(0.4), 0); close(value(0.5), 0.2); close(value(1.1), 0.4); close(value(1.6), 0.2); close(value(2.1), 0);
  await writeDocumentaryNarration(output, [cue('a', 500, 600, 'A')], [{ id: 'a', path: clip, durationMs: 1000 }], 1000, 1000);
  const cropped = await fs.promises.readFile(output); close(cropped.readFloatLE(0), 0.2); close(cropped.readFloatLE(30000 * 4), 0);
}));
test('5.1 mixer ducks every original channel and adds voice only to FC', async () => temporary(async (dir) => {
  const original = path.join(dir, 'original'), narration = path.join(dir, 'narration'), output = path.join(dir, 'out');
  await fs.promises.writeFile(original, floatPcm(48000, 6, 0.1));
  const voice = floatPcm(48000, 1, 0); for (let i = 12000; i < 36000; i++) voice.writeFloatLE(0.2, i * 4);
  await fs.promises.writeFile(narration, voice);
  await mixDocumentaryPcm(original, narration, output, 6, 1000, [{ startMs: 250, endMs: 750 }], { ...settings, attackMs: 0, releaseMs: 0 });
  const data = await fs.promises.readFile(output);
  for (let channel = 0; channel < 6; channel++) {
    close(data.readFloatLE((24000 * 6 + channel) * 4), 0.1 * 10 ** (-12 / 20) + (channel === 2 ? 0.2 : 0));
    close(data.readFloatLE((1000 * 6 + channel) * 4), 0.1);
  }
}));
test('subprocess cancellation and publication never overwrite an existing output', async () => temporary(async (dir) => {
  const controller = new AbortController();
  const job = runProcess(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], controller.signal);
  controller.abort(); await assert.rejects(() => job, { name: 'AbortError' });
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  await fs.promises.writeFile(a, 'new'); await fs.promises.writeFile(b, 'original');
  await assert.rejects(() => publishDocumentaryOutput(a, b)); assert.equal(await fs.promises.readFile(b, 'utf8'), 'original');
}));

for (const encoder of ['libx264', 'libx265']) {
  test(`${encoder}: full local pipeline, original packet hashes, 5.1, subtitles, chapters, attachments and sample`, async () => temporary(async (dir) => {
    const source = path.join(dir, 'original.mkv'), output = path.join(dir, 'dubbed.mkv');
    const subtitles = path.join(dir, 'cs.srt'), metadata = path.join(dir, 'metadata.txt'), attachment = path.join(dir, 'notes.txt');
    await fs.promises.writeFile(subtitles, '1\n00:00:01,000 --> 00:00:01,300\nStádo přichází.\n\n2\n00:00:01,600 --> 00:00:02,000\nDravec čeká.\n\n3\n00:00:05,400 --> 00:00:06,800\nMláďata zůstávají spolu.\n');
    await fs.promises.writeFile(metadata, ';FFMETADATA1\ntitle=Original title\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=7000\ntitle=One\n');
    await fs.promises.writeFile(attachment, 'Original attachment');
    const videoArgs = encoder === 'libx265' ? ['-x265-params', 'pools=1:frame-threads=1:log-level=error:keyint=50:min-keyint=50:scenecut=0'] : ['-g', '50', '-keyint_min', '50', '-sc_threshold', '0'];
    await runProcess(tools.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=25:duration=8',
      '-f', 'lavfi', '-i', 'aevalsrc=0.01*sin(2*PI*100*t)|0.01*sin(2*PI*200*t)|0.01*sin(2*PI*300*t)|0.01*sin(2*PI*60*t)|0.01*sin(2*PI*400*t)|0.01*sin(2*PI*500*t):s=48000:d=8:c=5.1',
      '-i', subtitles, '-f', 'ffmetadata', '-i', metadata, '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map_metadata', '3', '-map_chapters', '3',
      '-c:v', encoder, '-preset', 'ultrafast', ...videoArgs, '-c:a', 'flac', '-c:s', 'srt', '-metadata:s:a:0', 'language=eng', '-metadata:s:s:0', 'language=ces',
      '-attach', attachment, '-metadata:s:t:0', 'mimetype=text/plain', '-t', '8', source], undefined, 60000);
    const media = await probeDocumentary(source, tools), stat = await fs.promises.stat(source);
    const cues = [cue('a', 1000, 1300, 'Stádo přichází.'), cue('b', 1600, 2000, 'Dravec čeká.'), cue('c', 5400, 6800, 'Mláďata zůstávají spolu.')];
    const project: DocumentaryProject = { version: 1, id: randomUUID(), revision: 0, mediaPath: source, mediaSize: stat.size, mediaMtimeMs: stat.mtimeMs,
      audioStreamIndex: 1, sourceCues: cues, cues, subtitleSource: subtitles, settings, reviewed: true };
    let calls = 0; const fake = (async () => { calls++; return response(wav()); }) as typeof fetch;
    const context = { tools, cacheDirectory: path.join(dir, 'cache'), apiKey: 'fake', fetcher: fake, progress: () => {} };
    assert.match(await extractDocumentarySubtitles(source, 2, media, tools), /Stádo přichází/);
    const result = await renderDocumentary(project, media, output, undefined, context);
    assert.equal(calls, 3); assert.ok(result.overlaps.length > 0); assert.equal(result.originMs, 0);
    const after = await probeDocumentary(output, tools); assert.equal(after.streams.length, media.streams.length + 1);
    const dub = after.streams.filter((s) => s.codec_type === 'audio')[1];
    assert.equal(dub.channels, 6); assert.equal(dub.codec_name, 'eac3'); assert.equal(dub.tags?.language, 'ces');
    const packetHash = async (file: string, stream: string) => {
      const text = await runProcess(tools.ffprobe, ['-v', 'error', '-select_streams', stream, '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json', file]);
      return JSON.parse(text).packets.map((p: any) => p.data_hash);
    };
    for (const stream of ['v:0', 'a:0', 's:0']) assert.deepEqual(await packetHash(output, stream), await packetHash(source, stream));
    const info = JSON.parse(await runProcess(tools.ffprobe, ['-v', 'error', '-show_chapters', '-show_format', '-of', 'json', output]));
    assert.equal(info.chapters[0].tags.title, 'One'); assert.equal(info.format.tags.title, 'Original title');
    assert.equal(after.streams.find((s) => s.codec_type === 'attachment')?.tags?.filename, 'notes.txt');
    await generateDocumentaryCue(cues[0], { ...project, settings: { ...settings, speed: 1.1 } }, context);
    assert.equal(calls, 3, 'speed changes must reuse paid synthesis');
    await generateDocumentaryCue(cues[0], project, context, true); assert.equal(calls, 4);
    const sample = await renderDocumentary(project, media, path.join(dir, 'sample.mkv'), { startMs: 5300, durationMs: 2000 }, context);
    assert.equal(calls, 4, 'sample must reuse full render cache');
    assert.ok(sample.originMs <= 5300 && sample.originMs >= 3000, `sample origin ${sample.originMs}`);
    assert.ok(sample.durationMs >= 2000 && sample.durationMs < 5000, `sample duration ${sample.durationMs}`);
    await runProcess(tools.ffmpeg, ['-v', 'error', '-i', sample.outputPath, '-map', '0:v:0', '-f', 'null', '-']);
    const hash = createHash('sha256').update(await fs.promises.readFile(source)).digest('hex');
    await assert.rejects(() => renderDocumentary(project, media, source, undefined, context));
    assert.equal(createHash('sha256').update(await fs.promises.readFile(source)).digest('hex'), hash);
    await assert.rejects(() => renderDocumentary({ ...project, reviewed: false }, media, path.join(dir, 'unreviewed.mkv'), undefined, context));
    assert.equal(calls, 4);
  }));
}
