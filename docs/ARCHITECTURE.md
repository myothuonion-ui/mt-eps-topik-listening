# Listening Factory architecture (v1.2.0)

## Runtime

The application is a local React client plus an Express server bound to `127.0.0.1`. Each production run is a durable job under `data/jobs/<job-id>`; `data/` is ignored by Git.

## Media pipeline

```text
YouTube URL ─ validate/version/metadata ─ Korean VTT captions ─┐
                                                             ├─ normalize source.wav ─ timestamp transcript
YouTube without captions ─ robust audio download ─ Whisper ──┤
Local media ─ preserved upload ─ normalize ─ Whisper ─────────┘
Korean numbered text ─────────────────────────────────────────── direct Q1-Q20 scripts

timestamp transcript ─ number/cue/gap/sequential splitter ─ editable Q01-Q20 ─ source clips
editable scripts ─ Gemini TTS or Windows TTS ─ generated clips
generated clip ?? source clip ─ final audio + JSON/TXT/PDF/JSONL ─ ZIP
```

YouTube access is public by default. Browser cookies are passed only for an explicitly selected browser-session mode. The downloader owns a process-level usage lease, so the local executable cannot be replaced during an active job.

## State and persistence

Percentage is presentation-only. Every pipeline stage and question has an explicit `waiting`, `running`, `success`, `failed`, or `skipped` state. Starting a new stage completes only the previously running stage; a failure marks the actual active stage/question failed regardless of percentage.

All mutations happen in memory synchronously and enqueue an immutable snapshot on a per-job promise chain. Snapshot files use unique names, durable writes, normal atomic rename where supported, and a Windows backup/rollback replacement path. Rejected persistence operations are contained and cannot become unhandled promise rejections or crash the server.

## Security boundaries

- Gemini keys exist only in the request/UI session (or explicit local-browser storage) and are never added to job state.
- Cookie values and PO tokens are owned by yt-dlp and never read by application code.
- Structured logs and diagnostics pass through a shared redactor before disk, API, or export.
- Original media is preserved; all normalization, cuts, and generated audio use separate outputs.

## Error contract

An `AppError` may provide: stable code, timestamp, stage, question, agent, provider, tool, HTTP status, exit code, source range, retryability, reason, fix, and expandable sanitized detail. Generic failures are converted at the API/pipeline boundary and persisted as JSONL.
