---
title: Documentary voice-over
description: Local, reviewable Czech voice-over with Google Gemini TTS, start-only timing and a stream-copy Matroska export.
---

# Documentary voice-over

Open **Dubbing → Documentary voice-over**. This is an independent mode inside the existing dubbing page; standard dubbing, alignment and provider configuration are unchanged. The Google adapter belongs to this mode, not the standard workbench's provider dropdown. No subscription or hosted workflow is required.

## Requirements and setup

Use the normal SmartSub development/build procedure for this branch. No new npm dependencies are required. A supported FFmpeg build and **ffprobe** are required. SmartSub bundles FFmpeg but does not bundle ffprobe. On macOS install both with `brew install ffmpeg`; `/opt/homebrew/bin/ffprobe`, `/usr/local/bin/ffprobe`, the bundled FFmpeg directory, and PATH are checked. `SMARTSUB_FFMPEG_PATH` and `SMARTSUB_FFPROBE_PATH` can override the executable paths. Executables are run without a shell.

This implementation uses the **Google Gemini Developer API (AI Studio key)**, not the Google Cloud Text-to-Speech service-account API. Enter a key in the voice section, or launch the application with `GEMINI_API_KEY` in its environment. A typed key is retained only in the main process's session memory and cleared from the renderer after use; it is not saved in project JSON, synthesis cache keys or logs. Only the chosen subtitle text and style are sent to Google. Source video and audio are never uploaded by this mode. Google's API billing and data policies still apply.

The default is `gemini-3.8-flash-tts`. The adapter follows the [Google speech-generation REST guide](https://ai.google.dev/gemini-api/docs/generate-content/speech-generation): 3.8 uses verbatim text, `speech_metadata.style`, and `voiceConfig.voice`. Older 3.1/2.5 TTS model IDs use the legacy combined prompt and `prebuiltVoiceConfig`. Availability depends on the account/model. Live Google synthesis is deliberately not part of the tests.

### Voice Design IDs from AI Studio

Voice Design itself is intentionally **not** implemented in SmartSub. Create and iterate the voice separately in Google AI Studio, then choose **Designed voice ID** in the documentary mode and paste the persistent `voice_...` ID plus any local display name you want. The display name is project metadata only: it is not sent to Google and changing it does not invalidate cached synthesis. The TTS request sends only the selected designed voice ID.

A designed voice is scoped to the Google project/account that created or can access it, so use an API key with access to that same voice. This branch only permits designed IDs with Gemini 3.8 TTS; legacy TTS model request shapes remain limited to prebuilt voices.

## Workflow

1. Open a local video and choose its original audio stream. The source remains unchanged.
2. Select an embedded Czech text subtitle track or import UTF-8 SRT, ASS/SSA or VTT. Bitmap PGS/VobSub tracks require an external text file; there is no OCR step. Existing Czech translations are used, so an LLM or Whisper is not required.
3. **Load and group** proposes utterances. Grouping uses pauses, sentence boundaries and basic speaker markers; it is deliberately conservative. Caption formatting is removed. Sound-only bracketed/music cues are proposed as skipped. Inspect these decisions rather than treating grouping as semantic understanding.
4. Review the list alongside the video. Edit text/start/end, merge adjacent cues, split at the text cursor with an explicit split time, or skip a cue. Source cue IDs and originals are retained. Undo/redo, regrouping and project save/export are available. Every cue edit clears approval. End times are review/grouping hints, not synthesis deadlines.
5. Choose either a Google prebuilt voice or paste a `voice_...` Voice Design ID created in AI Studio. A local profile name can make the ID recognizable in the project. Voice/style presets continue to set the narration style; when a designed voice is active, choosing a style preset does not replace its ID. **Audition** uses cached audio; **Regenerate** forces only that cue's paid synthesis.
6. Approve the reviewed cues, render a sample, and tune the global speed/mix. Then render the full video.

Electron's embedded player may not preview every source codec/container. This does not trigger a transcode; use an external player to inspect an unsupported preview or the rendered sample. The subtitle review and FFmpeg export still operate on the original file.

## Timing, cost and recovery

Each generated clip starts at the reviewed cue's start. There is no subtitle-slot fitting, per-cue speed guessing, sentence truncation or shifting of later cues. The same global `atempo` multiplier (0.5–2.0) is applied locally to every clip. Shorter clips naturally leave gaps. Overlapping speech is mixed at its original starts and reported after render, not silently moved. Diagnostic output is bounded to 10,000 overlap pairs. Inspect the highlighted cue and edit it or choose another global speed.

Raw synthesis is cached by model, effective voice ID, style, language and exact text. Changing a designed voice's local profile name, start times, speed, ducking or codec does not pay for synthesis again. Changed text regenerates only that content; a forced regeneration bypasses the raw cache. Cancellation/failure preserves completed cached synthesis and the project. The project can be reopened from the mode's recent-project list or exported JSON; it is not added to SmartSub's general task list or automation/MCP service in this version.

Projects and cache live under `<Electron userData>/documentary/{projects,cache}`. Project writes use a temporary file and rename, validate revisions and whitelist persisted fields. Simultaneous access from different windows is refused. Source size/mtime are checked before reuse. Save edits before leaving; the normal navigation/close guard protects unsaved work. The last in-memory edits are not autosaved on every keystroke.

Each request is conservatively limited to 4,000 UTF-8 bytes and each raw clip to 120 seconds. Split longer text in Review rather than silently truncating it. Quota/transient server responses get bounded retries; other failures stop with the cue ID. Successful earlier cues remain cached.

## Surround audio and output

**Auto** preserves recognized mono, stereo, `5.1` or `5.1(side)` layouts. Other layouts require an explicit stereo/5.1 downmix choice; they are not guessed. All original channels, including LFE, receive the same ducking envelope, derived from actual generated clip durations with configurable attack/release. Nearby intervals merge to prevent pumping. Mono narration is added **only to FC** for six-channel output; stereo receives equal-power center panning. A final limiter protects the new mix against clipping.

Only the new mix is encoded: E-AC-3, AC-3 or AAC at 48 kHz. The new mix is channel-based, not object-based Atmos; original object-based/HD tracks are retained untouched when FFmpeg can remux them. Input decoding is limited by the installed FFmpeg build, not a hardcoded audio-codec shortlist.

Full output is **MKV only**, with all original streams mapped, video/audio/subtitles stream-copied, source metadata/chapters/attachments retained, plus a Czech audio track. MKV may reorder attachments and rewrite container metadata; the resulting file is not byte-identical to the source container. The coded video packets are not re-encoded. Unsupported remux combinations fail in a preflight before paid synthesis; the program never drops streams or falls back to a video encoder. The original remains available and no existing output file is overwritten. Final speech beyond the original video end is retained as an audio tail and reported.

Intermediate mixing is block-based disk PCM, not an in-memory movie. Allow several GiB per hour for six-channel working audio plus the output video. Disk-space and encoder checks run before synthesis. Temporary job files are removed on completion/failure/cancellation; successful TTS caches are retained.

## Samples

Set a start and a duration of 1–300 seconds (default 60). A sample uses the same synthesis cache, start-only placement, mixer and muxer as full output. **Video is never re-encoded**, so sample starts may move to an earlier keyframe and durations are approximate. The actual source interval is displayed. Sample chapters are omitted rather than retaining incorrectly timed full-film chapter entries.

To include a spoken segment crossing the actual sample start, synthesis considers up to `120 seconds / speed + 1 second` of preceding cue starts. This can generate more text than the nominal sample minute; those clips are reused for the full render. Audio crossing the sample boundaries is intentionally cropped only at those sample boundaries. It is not truncated during a full render.

## Tests

From the repository root, with its normal development dependencies installed and FFmpeg/ffprobe on PATH:

```sh
npx tsx scripts/dubbing/test-documentary.ts
npx tsc --noEmit -p main/tsconfig.json
npx tsc --noEmit -p renderer/tsconfig.json
```

The new test file uses Node's test runner and a fake Google response: **zero live API calls**. It tests grouping/provenance, review edits, validation, start-only overlaps, envelope transitions, request/response contracts, retry/cancellation, cache reuse, no-clobber publishing, sparse timeline cropping and six-channel FC-only mixing. Synthetic H.264 and H.265 end-to-end cases compare every original video/audio/subtitle packet's SHA-256 and verify retained chapters/attachments plus the new 5.1 track and a copy-cut sample.

Implementation-time validation: the 13 new tests and TypeScript checking of the dependency-free backend modules/test suite passed in a Linux container. Full application typecheck/build and interactive macOS/Electron testing were not available there. Live Google output quality and credentials must still be validated with a short audition/sample on the target machine.
