import type { ListeningQuestion, QuestionAudioType, TranscriptSegment } from '../../src/shared.js';

const KOREAN_NUMBERS: Record<string, number> = {
  '일':1,'이':2,'삼':3,'사':4,'오':5,'육':6,'칠':7,'팔':8,'구':9,'십':10,
  '십일':11,'십이':12,'십삼':13,'십사':14,'십오':15,'십육':16,'십칠':17,'십팔':18,'십구':19,'이십':20
};

function marker(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const arabic = normalized.match(/(?:^|\s|문제\s*)(\d{1,2})\s*(?:번|번\.|[.)번])/);
  if (arabic) {
    const n = Number(arabic[1]);
    if (n >= 1 && n <= 20) return n;
  }
  for (const [word, n] of Object.entries(KOREAN_NUMBERS).sort((a, b) => b[0].length - a[0].length)) {
    const compact = normalized.replace(/\s+/g, '');
    if (compact.includes(`${word}번`)) return n;
  }
  return null;
}

function detectType(text: string): QuestionAudioType {
  const t = text.replace(/\s+/g, ' ');
  if (/그림|사진|보기의 그림|알맞은 그림/.test(t)) return 'image_choice';
  const choiceHits = (t.match(/(?:^|\s)(?:1|2|3|4|①|②|③|④)\s*(?:번|[.)])/g) ?? []).length;
  if (choiceHits >= 3) return 'spoken_choices';
  if (/(남자|남:|여자|여:)/.test(t) || /[-–—]\s*[^-–—]+[-–—]/.test(t)) return 'dialogue';
  if (t.length < 80 && /무엇|어디|언제|누구|왜|어떻게|고르|맞는|알맞/.test(t)) return 'question_only';
  if (t.length >= 80) return 'monologue';
  return 'unknown';
}

function parseChoices(text: string) {
  const marks = [...text.matchAll(/(?:^|\s)([1-4①②③④])\s*(?:번|[.)])\s*/g)];
  if (marks.length < 4) return [] as string[];
  const choices: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const start = marks[i].index! + marks[i][0].length;
    const end = i < 3 ? marks[i + 1].index! : text.length;
    choices.push(text.slice(start, end).trim());
  }
  return choices.every(Boolean) ? choices : [];
}

function questionTextFrom(text: string) {
  const first = text.split(/(?<=[.?!다요까])\s+/).find(row => /무엇|어디|언제|누구|왜|어떻게|고르|맞는|알맞/.test(row));
  return first?.trim() ?? '';
}

function textInRange(segments: TranscriptSegment[], start: number, end: number) {
  return segments.filter(s => s.end > start && s.start < end).map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
}

function anchorsFrom(segments: TranscriptSegment[]) {
  const map = new Map<number, number>();
  for (const segment of segments) {
    const n = marker(segment.text);
    if (n && !map.has(n)) map.set(n, segment.start);
  }
  return map;
}

function interpolateStart(q: number, anchors: Map<number, number>, duration: number) {
  if (anchors.has(q)) return { time: anchors.get(q)!, source: 'explicit-number' as const, confidence: 0.98 };
  const lower = [...anchors.entries()].filter(([n]) => n < q).sort((a, b) => b[0] - a[0])[0];
  const upper = [...anchors.entries()].filter(([n]) => n > q).sort((a, b) => a[0] - b[0])[0];
  if (lower && upper) {
    const ratio = (q - lower[0]) / (upper[0] - lower[0]);
    return { time: lower[1] + (upper[1] - lower[1]) * ratio, source: 'interpolated' as const, confidence: 0.68 };
  }
  if (lower) {
    const avg = duration / 20;
    return { time: lower[1] + (q - lower[0]) * avg, source: 'interpolated' as const, confidence: 0.55 };
  }
  if (upper) {
    const avg = duration / 20;
    return { time: Math.max(0, upper[1] - (upper[0] - q) * avg), source: 'interpolated' as const, confidence: 0.55 };
  }
  return { time: (q - 1) * duration / 20, source: 'equal-fallback' as const, confidence: 0.25 };
}

export function splitIntoTwenty(segments: TranscriptSegment[], durationInput?: number): ListeningQuestion[] {
  const duration = Math.max(durationInput ?? 0, ...segments.map(s => s.end), 1);
  const anchors = anchorsFrom(segments);
  const starts = Array.from({ length: 20 }, (_, i) => interpolateStart(i + 1, anchors, duration));
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i].time <= starts[i - 1].time + 0.2) starts[i].time = Math.min(duration, starts[i - 1].time + duration / 20);
  }
  return starts.map((entry, index) => {
    const number = index + 1;
    const start = Math.max(0, entry.time);
    const end = Math.max(start + 0.5, index < 19 ? starts[index + 1].time - 0.06 : duration);
    const transcript = textInRange(segments, start, end);
    const type = detectType(transcript);
    const flags: string[] = [];
    if (entry.source === 'equal-fallback') flags.push('BOUNDARY_LOW_CONFIDENCE');
    if (!transcript) flags.push('NO_TRANSCRIPT_IN_RANGE');
    if (type === 'unknown') flags.push('TYPE_REVIEW');
    return {
      number, start, end, confidence: entry.confidence, boundarySource: entry.source, type,
      transcript, script: transcript, questionText: questionTextFrom(transcript), choices: parseChoices(transcript), correctAnswerIndex: null,
      sourceAudioUrl: null, ttsAudioUrl: null, flags
    };
  });
}

export function markerCount(segments: TranscriptSegment[]) {
  return anchorsFrom(segments).size;
}
