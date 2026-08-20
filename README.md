# MT EPS TOPIK Listening Factory v1.2.0

A Windows 11 single-user production studio for turning YouTube, local media, or Korean scripts into editable EPS-TOPIK Q1–Q20 listening packages. It is an audio-production tool, not a generic AI question generator.

## One-click Windows start

Double-click `Start-Listening-Factory.bat`. The launcher:

1. verifies Node.js 20.19+;
2. installs/refreshes npm dependencies;
3. checks FFmpeg, a project-local yt-dlp, optional Whisper, and Windows voices;
4. builds the client/server;
5. starts the local-only server at `127.0.0.1:8790`;
6. waits for `/api/health` and opens the browser.

Run tool setup directly when needed:

```powershell
powershell -File scripts\Setup-Tools.ps1
powershell -File scripts\Setup-Tools.ps1 -UpdateYtDlp
powershell -File scripts\Setup-Tools.ps1 -InstallPoTokenProvider
```

Whisper is optional and is invoked only when usable Korean YouTube captions are unavailable (or for local uploaded media). If Korean Windows speech is missing, install it through **Settings → Time & language → Language & region → Korean → Language options → Speech**, restart the app, or use Gemini TTS.

## Production workflow

- **YouTube URL:** validate URL → verify yt-dlp → metadata → Korean captions → robust audio attempts → FFmpeg normalization → transcript → Q1–Q20 split → source clips.
- **Local audio/video:** preserve upload → normalize a separate `source.wav` → Whisper Korean timestamps → Q1–Q20 split → source clips.
- **Korean text:** load Q1/Q2 or 1번/2번 numbered scripts directly into 20 editable slots.
- Edit each question's timestamps, type, transcript, TTS script, question text, four choices, and answer. Preview/re-cut source audio and generate/download a voice clip independently.
- Generate with Gemini TTS (narrator/male/female voices) or Windows Local TTS, with speed, post-processed pitch, volume, and line pauses.
- Export uses regenerated audio where present and otherwise falls back question-by-question to source audio.

## YouTube access and diagnostics

The default **Auto / Public** mode never reads browser cookies. **Use browser session** adds `--cookies-from-browser` only after the user explicitly selects Chrome, Edge, or Firefox. Cookies and PO tokens are never persisted, logged, committed, or exported.

Audio attempts use current yt-dlp behavior in this order:

1. default clients with automatic provider fetching;
2. the `mweb` client with the installed PO Token provider when ready;
3. a supported `web_safari` HLS fallback.

Failures are classified as `YT-403-POT`, `YT-403-ACCESS`, `YT-LOGIN-REQUIRED`, `YT-PRIVATE`, `YT-GEO`, `YT-FORMAT`, `YT-COOKIE`, `YT-PROVIDER-MISSING`, or `YT-DOWNLOAD-UNKNOWN`. The app shows exact stage, agent, provider/tool, HTTP/exit status, retryability, source range/question, fix, and sanitized technical detail.

The tool panel shows installed/latest yt-dlp versions and blocks replacement while a download is active. The updater downloads to a unique temporary file, validates it, and preserves the previous executable on replacement failure.

## Transcript and splitter

The application never sends a YouTube video to Gemini for inspection. It prefers timestamped Korean captions, then uses local Whisper only when captions are unavailable. Q1–Q20 boundaries combine explicit `1번`…`20번` markers, `다음` cues, silence gaps, sequential order, interpolation, and the expected count of 20. Low-confidence boundaries are flagged for manual review.

Supported types: dialogue, conversation, monologue, announcement, question-only, spoken choices, image choice, number, and unknown.

## Final ZIP

`MT_EPS_Listening_Set.zip` contains:

```text
audio/Q01.mp3 ... Q20.mp3
audio/full_listening.mp3
source_audio/Q01-source.mp3 ...
transcript/transcript.txt
transcript/transcript.json
data/questions.json
diagnostics/job-log.jsonl
answer_key.pdf
```

Optional empty fields do not block export. At least one generated or source question clip is required.

## Privacy and persistence

- Original uploads/YouTube media, normalized `source.wav`, source clips, and generated clips remain separate under ignored local `data/jobs` storage.
- Gemini API keys stay in local UI memory unless the user explicitly opts to remember the key in that browser. Keys never enter `job.json`, diagnostics, logs, Git, or ZIP files.
- Job snapshots use serialized per-job writes, unique temporary names, durable writes, and safe replacement/rollback on Windows. Sanitized `diagnostics/job-log.jsonl` is persisted with every snapshot.

## Development verification

```powershell
npm install
npm run typecheck
npm run smoke
npm run build
npm start
```

`npm run smoke` covers concurrent persistence, explicit progress failure, Q1–Q20 splitting, YouTube access/fallback/classification, PO provider absence, secret sanitization, Gemini request/error validation, and export source fallback.
