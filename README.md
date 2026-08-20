# MT EPS TOPIK Listening Factory v1.0.0

Local teacher tool for building EPS-TOPIK listening packages without AI video analysis.

## Normal workflow

1. Double-click `Start-Listening-Factory.bat`.
2. Paste a YouTube URL (or upload audio/video).
3. The app checks timestamped YouTube captions first.
4. If captions are unavailable, local Whisper transcribes Korean audio.
5. Q1–Q20 boundaries are detected from spoken/caption question numbers; missing anchors are interpolated and visibly flagged.
6. Play each Q clip. Edit Start/End and click **Re-cut Source** when needed.
7. Edit the script and optional visual choices/answer.
8. Use Voice Studio to choose narrator/male/female Windows voices, speed, pitch, volume and pauses.
9. Generate all voices (optional).
10. Download the final ZIP.

## Final ZIP

- `Audio/Q01.mp3` … `Q20.mp3`
- `Full_Listening_Test.mp3`
- `Transcript/full-transcript.txt`
- `Transcript/question-scripts.txt`
- `Data/questions.json`
- `Data/job.json`
- `PDF/answer-sheet.pdf`

Customized TTS is preferred in the export when generated; otherwise the source YouTube/audio clip is used.

## Local tools

- FFmpeg / FFprobe — normalize, split, pitch, combine audio
- yt-dlp — YouTube captions/audio download
- OpenAI Whisper CLI — local transcription fallback when captions are unavailable
- Windows System.Speech — local customizable TTS

Run `scripts/Setup-Tools.ps1` if a tool is shown as not ready.

## Error diagnostics

Every pipeline failure is converted to a structured error with error ID, agent, stage, source file/line when available, reason, fix suggestion, and technical detail. A persistent JSONL error log is written under `data/diagnostics/errors.jsonl`.

## Development

```bash
npm install
npm run typecheck
npm run smoke
npm run build
npm start
```

Local URL: `http://127.0.0.1:8790`
