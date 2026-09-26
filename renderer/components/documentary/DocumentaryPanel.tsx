import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useNavigationGuard } from '@/context/NavigationGuardContext';
import {
  DOCUMENTARY_PRESETS, DOCUMENTARY_VOICES, groupDocumentaryCues, mergeDocumentaryCues, splitDocumentaryCue,
  type DocumentaryProject, type DocumentaryCue, type DocumentarySettings, type DocumentarySnapshot, type DocumentaryProgress,
} from '../../../types/documentary';

const mediaUrl = (file: string) => `media://${encodeURIComponent(file)}`;
const time = (ms: number) => `${Math.floor(ms / 3600000).toString().padStart(2, '0')}:${Math.floor(ms / 60000 % 60).toString().padStart(2, '0')}:${(ms / 1000 % 60).toFixed(3).padStart(6, '0')}`;
const selectClass = 'h-9 rounded-md border border-input bg-background px-2 text-sm';
const areaClass = 'w-full rounded-md border border-input bg-background p-2 text-sm';

export default function DocumentaryPanel() {
  const { t } = useTranslation('documentary');
  const [snapshot, setSnapshot] = useState<DocumentarySnapshot | null>(null);
  const [draft, setDraft] = useState<DocumentaryProject | null>(null);
  const [recent, setRecent] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedId, setSelectedId] = useState('');
  const [subtitle, setSubtitle] = useState('external');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<DocumentaryProgress | null>(null);
  const [past, setPast] = useState<DocumentaryCue[][]>([]);
  const [future, setFuture] = useState<DocumentaryCue[][]>([]);
  const [page, setPage] = useState(0);
  const [caret, setCaret] = useState(0);
  const [splitMs, setSplitMs] = useState(0);
  const [sampleStart, setSampleStart] = useState(0);
  const [sampleDuration, setSampleDuration] = useState(60);
  const [audition, setAudition] = useState<{ path: string; durationMs: number } | null>(null);
  const [result, setResult] = useState<{ outputPath: string; originMs: number; durationMs: number; tailMs: number;
    overlaps: Array<{ first: string; second: string; overlapMs: number }> } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const dirty = useMemo(() => Boolean(draft && snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.project)), [draft, snapshot]);
  const selectedIndex = draft?.cues.findIndex((cue) => cue.id === selectedId) ?? -1;
  const selected = selectedIndex >= 0 ? draft!.cues[selectedIndex] : undefined;

  useEffect(() => {
    let active = true;
    window.ipc.invoke('documentary:recent').then((items) => { if (active) setRecent(items); }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, []);
  useEffect(() => window.ipc.on('documentary:progress', (payload) => {
    const value = payload as DocumentaryProgress;
    if (value.sessionId === snapshot?.sessionId) setProgress(value);
  }), [snapshot?.sessionId]);

  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(''); setProgress(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function accept(value: DocumentarySnapshot | null) {
    if (!value) return;
    setSnapshot(value); setDraft(value.project); setSelectedId(value.project.cues[0]?.id || '');
    setPast([]); setFuture([]); setPage(0); setResult(null); setAudition(null);
    const cs = value.media.streams.find((s) => s.codec_type === 'subtitle' && /^(?:cs|ces|cze)(?:-|$)/i.test(s.tags?.language || ''));
    setSubtitle(cs ? String(cs.index) : 'external');
  }
  async function save(): Promise<DocumentarySnapshot> {
    if (!draft || !snapshot) throw new Error(t('openFirst'));
    if (!dirty) return snapshot;
    const value = await window.ipc.invoke('documentary:save', snapshot.sessionId, draft) as DocumentarySnapshot;
    setSnapshot(value); setDraft(value.project);
    return value;
  }
  useNavigationGuard('documentary', {
    isDirty: dirty || busy,
    onSave: async () => {
      if (busy) return false;
      try { await save(); return true; } catch (e) { setError(String(e)); return false; }
    },
    onDiscard: () => {
      if (busy) return false;
      setDraft(snapshot?.project || null); return true;
    },
  });
  function changeCues(cues: DocumentaryCue[]) {
    if (!draft) return;
    setPast((history) => [...history.slice(-19), draft.cues]); setFuture([]);
    setDraft({ ...draft, cues, reviewed: false }); setResult(null); setAudition(null);
  }
  function changeCue(patch: Partial<DocumentaryCue>) {
    if (!draft || !selected) return;
    changeCues(draft.cues.map((cue) => cue.id === selected.id ? { ...cue, ...patch } : cue));
  }
  function setting<K extends keyof DocumentarySettings>(name: K, value: DocumentarySettings[K]) {
    if (!draft) return;
    setDraft({ ...draft, settings: { ...draft.settings, [name]: value } }); setResult(null); setAudition(null);
  }
  async function configureKey(sessionId: string) {
    if (key.trim()) { await window.ipc.invoke('documentary:api-key', sessionId, key); setKey(''); }
  }
  async function render(sample: boolean) {
    const value = await save();
    await configureKey(value.sessionId);
    const output = await window.ipc.invoke('documentary:render', value.sessionId,
      sample ? { startMs: Math.round(sampleStart * 1000), durationMs: Math.round(sampleDuration * 1000) } : undefined);
    if (output) setResult(output);
  }
  const numberSetting = (name: 'speed' | 'duckDb' | 'attackMs' | 'releaseMs' | 'narrationDb', min: number, max: number, step = 1) => (
    <label className="grid gap-1 text-sm">{t(name)}
      <Input type="number" min={min} max={max} step={step} value={draft!.settings[name]}
        onChange={(e) => setting(name, Number(e.target.value))} />
    </label>
  );

  return <div className="h-full overflow-auto pr-2">
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h2 className="mr-auto text-lg font-semibold">{t('title')}</h2>
      {busy && snapshot && <Button variant="outline" onClick={() => {
        window.ipc.invoke('documentary:cancel', snapshot.sessionId).catch((e) => setError(String(e)));
      }}>{t('cancel')}</Button>}
    </div>
    <p className="mb-3 text-sm text-muted-foreground">{t('intro')}</p>
    {error && <p role="alert" className="mb-3 whitespace-pre-wrap rounded border p-3 text-destructive">{error}</p>}
    {progress && <p role="status" className="mb-3 text-sm">{t(`stage.${progress.stage}`, { defaultValue: progress.stage })}
      {progress.total !== undefined && ` · ${progress.completed ?? 0}/${progress.total}`}{progress.cueId && ` · ${progress.cueId}`}</p>}
    <fieldset disabled={busy} className="min-w-0 space-y-4 disabled:opacity-70">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => perform(async () => { if (dirty) await save(); accept(await window.ipc.invoke('documentary:open-media')); })}>{t('openVideo')}</Button>
        <Button variant="outline" onClick={() => perform(async () => { if (dirty) await save(); accept(await window.ipc.invoke('documentary:open-project')); })}>{t('openProject')}</Button>
        {draft && <>
          <Button variant="outline" disabled={!dirty} onClick={() => perform(async () => { await save(); })}>{t('save')}{dirty ? ' *' : ''}</Button>
          <Button variant="outline" onClick={() => perform(async () => { const value = await save(); await window.ipc.invoke('documentary:export-project', value.sessionId); })}>{t('exportProject')}</Button>
        </>}
      </div>
      {!draft && recent.length > 0 && <div className="grid gap-1"><h3 className="font-medium">{t('recent')}</h3>
        {recent.map((item) => <Button key={item.id} variant="ghost" className="justify-start" onClick={() => perform(async () => accept(await window.ipc.invoke('documentary:open-project', item.id)))}>{item.name}</Button>)}
      </div>}
      {draft && snapshot && <>
        <section className="space-y-3 rounded-lg border p-3">
          <h3 className="font-semibold">{t('input')}</h3>
          <p className="break-all text-sm">{draft.mediaPath}</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">{t('audioTrack')}
              <select className={selectClass} value={draft.audioStreamIndex} onChange={(e) => setDraft({ ...draft, audioStreamIndex: Number(e.target.value) })}>
                {snapshot.media.streams.filter((s) => s.codec_type === 'audio').map((s) => <option key={s.index} value={s.index}>
                  #{s.index} · {s.tags?.language || '?'} · {s.codec_name} · {s.channel_layout || `${s.channels} ch`}
                </option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm">{t('subtitleTrack')}
              <select className={selectClass} value={subtitle} onChange={(e) => setSubtitle(e.target.value)}>
                <option value="external">{t('externalSubtitle')}</option>
                {snapshot.media.streams.filter((s) => s.codec_type === 'subtitle').map((s) => <option key={s.index} value={s.index}>#{s.index} · {s.tags?.language || '?'} · {s.codec_name}</option>)}
              </select>
            </label>
            <Button variant="outline" onClick={() => perform(async () => {
              if (draft.cues.length && !window.confirm(t('replaceSubtitles'))) return;
              const value = await save();
              accept(await window.ipc.invoke('documentary:subtitles', value.sessionId, subtitle === 'external' ? 'external' : Number(subtitle)));
            })}>{t('loadSubtitles')}</Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('subtitleHint')}</p>
        </section>

        {draft.cues.length > 0 && <section className="space-y-3 rounded-lg border p-3">
          <h3 className="font-semibold">{t('review')} · {draft.cues.length}</h3>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => { if (window.confirm(t('regroupConfirm'))) changeCues(groupDocumentaryCues(draft.sourceCues)); }}>{t('regroup')}</Button>
            <Button variant="outline" disabled={!past.length} onClick={() => { const previous = past[past.length - 1]; setFuture([draft.cues, ...future]); setPast(past.slice(0, -1)); setDraft({ ...draft, cues: previous, reviewed: false }); setResult(null); }}>{t('undo')}</Button>
            <Button variant="outline" disabled={!future.length} onClick={() => { setPast([...past, draft.cues]); setDraft({ ...draft, cues: future[0], reviewed: false }); setFuture(future.slice(1)); setResult(null); }}>{t('redo')}</Button>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="space-y-2">
              <video ref={video} controls preload="metadata" className="max-h-64 w-full rounded" src={mediaUrl(draft.mediaPath)} />
              <p className="text-xs text-muted-foreground">{t('previewHint')}</p>
              <div className="flex items-center justify-between">
                <Button variant="outline" disabled={page === 0} onClick={() => setPage(Math.max(0, page - 1))}>‹</Button>
                <span className="text-sm">{Math.min(page + 1, Math.ceil(draft.cues.length / 25))} / {Math.ceil(draft.cues.length / 25)}</span>
                <Button variant="outline" disabled={(page + 1) * 25 >= draft.cues.length} onClick={() => setPage(page + 1)}>›</Button>
              </div>
              <div className="max-h-80 overflow-auto rounded border">
                {draft.cues.slice(Math.min(page, Math.floor((draft.cues.length - 1) / 25)) * 25, (Math.min(page, Math.floor((draft.cues.length - 1) / 25)) + 1) * 25).map((cue) => <button key={cue.id} type="button"
                  className={`block w-full border-b p-2 text-left text-sm ${cue.id === selectedId ? 'bg-accent' : ''} ${cue.skip ? 'opacity-50' : ''}`}
                  onClick={() => { setSelectedId(cue.id); setCaret(0); setAudition(null); if (video.current) video.current.currentTime = cue.startMs / 1000; }}>
                  <span className="font-mono text-xs">{time(cue.startMs)} · {cue.id}{cue.skip ? ' · skip' : ''}</span>
                  <span className="block truncate">{cue.text}</span>
                </button>)}
              </div>
            </div>
            {selected && <div className="space-y-3">
              <p className="text-sm">{selected.id} · {t('sourceCues')}: {selected.sourceCueIds.map((id) => id + 1).join(', ')}</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1 text-sm">{t('startSeconds')}<Input type="number" min="0" step="0.001" value={selected.startMs / 1000} onChange={(e) => changeCue({ startMs: Math.round(Number(e.target.value) * 1000) })} /></label>
                <label className="grid gap-1 text-sm">{t('endSeconds')}<Input type="number" min="0" step="0.001" value={selected.endMs / 1000} onChange={(e) => changeCue({ endMs: Math.round(Number(e.target.value) * 1000) })} /></label>
              </div>
              <textarea className={areaClass} rows={6} value={selected.text} onChange={(e) => changeCue({ text: e.target.value })}
                onSelect={(e) => { const at = e.currentTarget.selectionStart; setCaret(at); setSplitMs(Math.round(selected.startMs + (selected.endMs - selected.startMs) * at / Math.max(1, selected.text.length))); }} />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.skip} onChange={(e) => changeCue({ skip: e.target.checked })} />{t('skip')}</label>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={selectedIndex <= 0} onClick={() => { const id = draft.cues[selectedIndex - 1].id; changeCues(mergeDocumentaryCues(draft.cues, selectedIndex - 1)); setSelectedId(id); }}>{t('mergePrevious')}</Button>
                <Button variant="outline" disabled={selectedIndex + 1 >= draft.cues.length} onClick={() => changeCues(mergeDocumentaryCues(draft.cues, selectedIndex))}>{t('mergeNext')}</Button>
              </div>
              <label className="grid gap-1 text-sm">{t('splitTime')}<Input type="number" step="0.001" value={splitMs / 1000} onChange={(e) => setSplitMs(Math.round(Number(e.target.value) * 1000))} /></label>
              <Button variant="outline" onClick={() => { try {
                changeCues(splitDocumentaryCue(draft.cues, selectedIndex, caret, splitMs, `split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
              } catch (e) { setError(String(e)); } }}>{t('split')}</Button>
              <p className="text-xs text-muted-foreground">{t('splitHint')}</p>
              <div className="flex flex-wrap gap-2">
                {[false, true].map((force) => <Button key={String(force)} variant="outline" disabled={selected.skip} onClick={() => perform(async () => {
                  const value = await save(); await configureKey(value.sessionId);
                  setAudition(await window.ipc.invoke('documentary:audition', value.sessionId, selected.id, force));
                })}>{t(force ? 'regenerate' : 'audition')}</Button>)}
              </div>
              {audition && <div><audio controls autoPlay src={mediaUrl(audition.path)} /><p className="text-sm">{(audition.durationMs / 1000).toFixed(2)} s</p></div>}
            </div>}
          </div>
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={draft.reviewed} onChange={(e) => setDraft({ ...draft, reviewed: e.target.checked })} />{t('approve')}</label>
        </section>}

        <section className="space-y-3 rounded-lg border p-3">
          <h3 className="font-semibold">{t('voice')}</h3>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="grid gap-1 text-sm">{t('preset')}<select className={selectClass} defaultValue="" onChange={(e) => {
              const preset = DOCUMENTARY_PRESETS.find((p) => p.id === e.target.value);
              if (preset) {
                setDraft({ ...draft, settings: {
                  ...draft.settings,
                  ...(draft.settings.voiceSource === 'prebuilt' ? { voice: preset.voice } : {}),
                  style: preset.style,
                } });
                setResult(null);
              }
            }}><option value="">{t('custom')}</option>{DOCUMENTARY_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{t(`presetNames.${preset.id}`)}</option>)}</select></label>
            <label className="grid gap-1 text-sm">{t('voiceSource')}<select className={selectClass} value={draft.settings.voiceSource}
              onChange={(e) => setting('voiceSource', e.target.value as DocumentarySettings['voiceSource'])}>
              <option value="prebuilt">{t('prebuiltVoice')}</option>
              <option value="custom">{t('designedVoice')}</option>
            </select></label>
            {numberSetting('speed', 0.5, 2, 0.01)}
          </div>
          {draft.settings.voiceSource === 'prebuilt' ? <label className="grid gap-1 text-sm">{t('voiceName')}
            <select className={selectClass} value={draft.settings.voice} onChange={(e) => setting('voice', e.target.value)}>
              {DOCUMENTARY_VOICES.map((voice) => <option key={voice}>{voice}</option>)}
            </select>
          </label> : <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-sm">{t('profileName')}
              <Input maxLength={120} value={draft.settings.voiceProfileName} onChange={(e) => setting('voiceProfileName', e.target.value)} placeholder="Czech Documentary Male 1" />
            </label>
            <label className="grid gap-1 text-sm">{t('customVoiceId')}
              <Input maxLength={246} value={draft.settings.customVoiceId} onChange={(e) => setting('customVoiceId', e.target.value.trim())} placeholder="voice_..." />
            </label>
          </div>}
          {draft.settings.voiceSource === 'custom' && <p className="text-xs text-muted-foreground">{t('customVoiceHint')}</p>}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-sm">{t('model')}<Input value={draft.settings.model} onChange={(e) => setting('model', e.target.value)} /></label>
            <label className="grid gap-1 text-sm">{t('language')}<Input value={draft.settings.language} onChange={(e) => setting('language', e.target.value)} /></label>
          </div>
          <label className="grid gap-1 text-sm">{t('style')}<textarea className={areaClass} rows={3} value={draft.settings.style} onChange={(e) => setting('style', e.target.value)} /></label>
          <label className="grid gap-1 text-sm">{t('apiKey')}<Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="GEMINI_API_KEY" /></label>
          <p className="text-xs text-muted-foreground">{t('privacy')}</p>
          <p className="text-xs text-muted-foreground">{t('speedHint')}</p>
        </section>
        <section className="space-y-3 rounded-lg border p-3">
          <h3 className="font-semibold">{t('mix')}</h3>
          <div className="grid gap-3 md:grid-cols-3">
            {numberSetting('duckDb', -60, 0)}{numberSetting('attackMs', 0, 3000)}{numberSetting('releaseMs', 0, 5000)}
            {numberSetting('narrationDb', -30, 12)}
            <label className="grid gap-1 text-sm">{t('layout')}<select className={selectClass} value={draft.settings.layout} onChange={(e) => setting('layout', e.target.value as DocumentarySettings['layout'])}><option value="auto">{t('autoLayout')}</option><option value="5.1">5.1</option><option value="stereo">Stereo</option></select></label>
            <label className="grid gap-1 text-sm">{t('codec')}<select className={selectClass} value={draft.settings.codec} onChange={(e) => setting('codec', e.target.value as DocumentarySettings['codec'])}><option value="eac3">E-AC-3</option><option value="ac3">AC-3</option><option value="aac">AAC</option></select></label>
          </div>
          <p className="text-xs text-muted-foreground">{t('mixHint')}</p>
        </section>
        <section className="space-y-3 rounded-lg border p-3">
          <h3 className="font-semibold">{t('render')}</h3>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">{t('sampleStart')}<Input type="number" min="0" step="1" value={sampleStart} onChange={(e) => setSampleStart(Number(e.target.value))} /></label>
            <label className="grid gap-1 text-sm">{t('sampleDuration')}<Input type="number" min="1" max="300" value={sampleDuration} onChange={(e) => setSampleDuration(Number(e.target.value))} /></label>
            <Button disabled={!draft.reviewed || !draft.cues.length} onClick={() => perform(() => render(true))}>{t('renderSample')}</Button>
            <Button disabled={!draft.reviewed || !draft.cues.length} onClick={() => perform(() => render(false))}>{t('renderFull')}</Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('sampleHint')}</p>
          {result && <div className="space-y-2 text-sm"><p className="break-all">{result.outputPath}</p>
            <p>{t('actualRange')}: {time(result.originMs)} – {time(result.originMs + result.durationMs)}</p>
            {result.tailMs > 0 && <p>{t('tailWarning')}: {(result.tailMs / 1000).toFixed(2)} s</p>}
            {result.overlaps.length > 0 && <div role="alert"><p>{t('overlapWarning')}</p>
              {result.overlaps.slice(0, 30).map((overlap, i) => <button type="button" className="block underline" key={i} onClick={() => { setSelectedId(overlap.first); setPage(Math.floor(draft.cues.findIndex((cue) => cue.id === overlap.first) / 25)); }}>
                {overlap.first} / {overlap.second}: {(overlap.overlapMs / 1000).toFixed(2)} s</button>)}
            </div>}
          </div>}
        </section>
      </>}
    </fieldset>
  </div>;
}
