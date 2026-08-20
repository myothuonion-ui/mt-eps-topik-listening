# MT EPS TOPIK Listening Factory

## Goal
YouTube/audio/text -> transcript -> EPS listening analysis -> question package.

## Pipeline

1. Source Import
- YouTube URL
- Local audio/video
- Korean script

2. Audio Processing Agent
- yt-dlp
- ffmpeg normalization
- Whisper transcription

3. Listening Analyzer Agent
- Detect Q1-Q20
- Detect dialogue / monologue / image question
- Timestamp mapping

4. Question Builder
- Korean question
- 4 choices
- answer key
- script

5. Voice Factory
- TTS generation
- speed
- pause
- voice profile

6. Export
- MP3
- JSON
- TXT
- PDF
- ZIP package

## Debug System
Every error must show:
- Agent
- File
- Line
- Stage
- Fix suggestion

## Progress UI
Stages:
- Download
- Extract
- Transcribe
- Analyze
- Generate
- Export

Each stage reports percentage and logs.
