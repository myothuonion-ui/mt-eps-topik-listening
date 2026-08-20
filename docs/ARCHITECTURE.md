# EPS TOPIK Listening Factory Architecture

## Pipeline

Source
- YouTube URL
- Local audio/video
- Korean text

Audio Pipeline
- yt-dlp downloader
- ffmpeg converter
- Whisper transcription

Analysis
- Q1-Q20 detection
- Dialogue / monologue / picture type detection
- Timestamp mapping

Question Model
- question
- 4 choices
- answer
- script
- audio segment

Voice Studio
- TTS voice
- speed
- pitch
- pause

Export
- MP3
- JSON
- TXT
- PDF
- ZIP

## Progress Engine
Every job reports:
- current stage
- percentage
- completed stages
- current question
- logs

## Error Reporting
Every error includes:
- error id
- agent
- stage
- file
- line
- reason
- suggested fix
