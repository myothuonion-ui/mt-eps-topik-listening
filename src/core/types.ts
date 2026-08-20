export type ListeningQuestionType =
  | 'dialogue'
  | 'monologue'
  | 'announcement'
  | 'picture';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface ListeningQuestion {
  id: number;
  type: ListeningQuestionType;
  audioFile?: string;
  script: string;
  question: string;
  choices: string[];
  answerIndex: number;
  startTime?: number;
  endTime?: number;
}

export interface JobProgress {
  jobId: string;
  stage: string;
  percent: number;
  message: string;
}
