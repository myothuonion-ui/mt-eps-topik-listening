export type JobStage = 'queued' | 'validate' | 'download' | 'normalize' | 'transcribe' | 'split' | 'clip' | 'ready' | 'tts' | 'export' | 'done' | 'failed';
export type PipelineStageKey = 'validate' | 'download' | 'normalize' | 'transcript' | 'split' | 'clip' | 'voice' | 'export';
export type StageState = 'waiting' | 'running' | 'success' | 'failed' | 'skipped';
export type QuestionAudioType = 'dialogue' | 'conversation' | 'monologue' | 'announcement' | 'question_only' | 'spoken_choices' | 'image_choice' | 'number' | 'unknown';
export type BrowserName = 'chrome' | 'edge' | 'firefox';
export type YoutubeAccess = { mode: 'auto' | 'browser'; browser: BrowserName };
export type ProcessingMode = 'full-auto' | 'safe-auto' | 'manual';

export type BoundaryAutomation = {
  mode: ProcessingMode;
  geminiApiKey: string;
  geminiModel: string;
  nvidiaApiKey: string;
  nvidiaModel: string;
  cloudflareApiToken: string;
  cloudflareAccountId: string;
  cloudflareModel: string;
};

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
  sourceNumber: number;
  start: number;
  end: number;
  confidence: number;
  boundarySource: 'explicit-number' | 'range-header' | 'agent-verified' | 'manual-edit' | 'spoken-cue' | 'silence-gap' | 'interpolated' | 'equal-fallback' | 'text';
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
  provider?: string;
  httpStatus?: number | null;
  tool?: string;
  exitCode?: number | null;
  question?: number | null;
  retryable?: boolean;
  source?: string;
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
  stageStates: Record<PipelineStageKey, StageState>;
  questionStates: Record<string, StageState>;
  lastSuccessfulStage: PipelineStageKey | null;
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
  processingMode: ProcessingMode;
  boundaryAgent: 'gemini' | 'nvidia' | 'cloudflare' | 'deterministic' | 'manual';
  sourceQuestionRange: { start: number; end: number } | null;
  autoCutCount: number;
  reviewCount: number;
};

export type ToolStatus = {
  ffmpeg: boolean;
  ffprobe: boolean;
  ytdlp: boolean;
  whisper: boolean;
  powershell: boolean;
  ytdlpInfo: {
    installedVersion: string | null;
    latestVersion: string | null;
    status: 'current' | 'update-available' | 'missing' | 'unknown';
    activeJobs: number;
  };
  poTokenProvider: {
    status: 'ready' | 'missing';
    name: string | null;
    detail: string;
  };
};
