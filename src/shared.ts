export type JobStage = 'queued' | 'validate' | 'download' | 'normalize' | 'transcribe' | 'split' | 'clip' | 'ready' | 'tts' | 'export' | 'done' | 'failed';
export type QuestionAudioType = 'dialogue' | 'monologue' | 'question_only' | 'spoken_choices' | 'image_choice' | 'unknown';

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
  source: 'caption' | 'whisper' | 'text';
};

export type VoiceProfile = {
  provider: 'windows' | 'gemini';
  narratorVoice: string;
  maleVoice: string;
  femaleVoice: string;
  rate: number;
  pitch: number;
  volume: number;
  pauseMs: number;
  geminiApiKey: string;
  geminiModel: 'gemini-3.1-flash-tts-preview' | 'gemini-2.5-flash-preview-tts' | 'gemini-2.5-pro-preview-tts';
  geminiNarratorVoice: string;
  geminiMaleVoice: string;
  geminiFemaleVoice: string;
  geminiStyle: string;
};

export type ListeningQuestion = {
  number: number;
  start: number;
  end: number;
  confidence: number;
  boundarySource: 'explicit-number' | 'interpolated' | 'equal-fallback' | 'text';
  type: QuestionAudioType;
  transcript: string;
  script: string;
  questionText: string;
  choices: string[];
  correctAnswerIndex: number | null;
  sourceAudioUrl: string | null;
  ttsAudioUrl: string | null;
  flags: string[];
};

export type DiagnosticError = {
  id: string;
  timestamp: string;
  code: string;
  agent: string;
  stage: string;
  file: string | null;
  line: number | null;
  column: number | null;
  reason: string;
  fix: string;
  detail?: string;
};

export type JobLog = {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error';
  agent: string;
  stage: JobStage;
  percent: number;
  question: number | null;
  message: string;
};

export type ListeningJob = {
  id: string;
  sourceType: 'youtube' | 'upload' | 'text';
  sourceLabel: string;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'done';
  stage: JobStage;
  percent: number;
  currentAgent: string;
  currentQuestion: number | null;
  createdAt: string;
  updatedAt: string;
  transcriptSource: 'caption' | 'whisper' | 'text' | null;
  transcript: TranscriptSegment[];
  questions: ListeningQuestion[];
  logs: JobLog[];
  error: DiagnosticError | null;
  sourceAudioUrl: string | null;
  exportUrl: string | null;
  warnings: string[];
};

export type ToolStatus = {
  ffmpeg: boolean;
  ffprobe: boolean;
  ytdlp: boolean;
  whisper: boolean;
  powershell: boolean;
};
