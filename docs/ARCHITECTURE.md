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

timestamp transcript ─ rolling-caption cleanup ─ source range + section map ─ FFmpeg silence evidence
      └─ strict Gemini → NVIDIA → Cloudflare boundary-agent fallback ─ validated editable Q01-Q20 map
validated map ─ Full Auto: cut 20 | Safe Auto: cut high-confidence | Manual: await approval
editable scripts ─ Gemini TTS or Windows TTS ─ generated clips
generated clip ?? source clip ─ final audio + JSON/TXT/PDF/JSONL ─ ZIP
```

YouTube access is public by default. Browser cookies are passed only for an explicitly selected browser-session mode. The downloader owns a process-level usage lease, so the local executable cannot be replaced during an active job.

## State and persistence

Percentage is presentation-only. Every pipeline stage and question has an explicit `waiting`, `running`, `success`, `failed`, or `skipped` state. Starting a new stage completes only the previously running stage; a failure marks the actual active stage/question failed regardless of percentage.

All mutations happen in memory synchronously and enqueue an immutable snapshot on a per-job promise chain. Snapshot files use unique names, durable writes, normal atomic rename where supported, and a Windows backup/rollback replacement path. Rejected persistence operations are contained and cannot become unhandled promise rejections or crash the server.

## Security boundaries

- NVIDIA and Cloudflare credentials exist only in the request/UI session. Gemini follows the same rule unless the user explicitly enables local-browser remembering. No provider secret is added to job state.
- Boundary providers receive timestamped transcript evidence, never the source video or audio. Their output cannot cut audio until the exact-20, source-number, monotonicity, range, overlap, and duration rules pass.
- Cookie values and PO tokens are owned by yt-dlp and never read by application code.
- Structured logs and diagnostics pass through a shared redactor before disk, API, or export.
- Original media is preserved; all normalization, cuts, and generated audio use separate outputs.

## Error contract

An `AppError` may provide: stable code, timestamp, stage, question, agent, provider, tool, HTTP status, exit code, source range, retryability, reason, fix, and expandable sanitized detail. Generic failures are converted at the API/pipeline boundary and persisted as JSONL.
