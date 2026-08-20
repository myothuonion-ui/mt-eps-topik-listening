import fs from 'node:fs/promises';
import path from 'node:path';
import type { BoundaryAutomation, ListeningQuestion, TranscriptSegment, YoutubeAccess } from '../src/shared.js';
import { diagnosticFrom } from './core/errors.js';
import { fail, jobDir, progress, skipStages, updateJob, warn } from './core/jobs.js';
import { cutQuestionClips, detectSilenceBoundaries, durationSeconds, normalizeAudio } from './services/audio.js';
import { loadBestCaption, normalizeTranscriptSegments, transcribeWithWhisper } from './services/transcript.js';
import { applyBoundaryProposals, detectQuestionRange, markerCount, splitIntoTwenty } from './services/splitter.js';
import { runBoundaryAgentFallback } from './services/boundary-agents.js';
import { downloadYoutubeAudio, fetchYoutubeCaptions, inspectYoutube, validateYoutubeUrl } from './services/youtube.js';

const DEFAULT_AUTOMATION: BoundaryAutomation = {
  mode: 'full-auto', geminiApiKey: '', geminiModel: 'gemini-2.5-flash', nvidiaApiKey: '', nvidiaModel: 'meta/llama-3.1-8b-instruct',
  cloudflareApiToken: '', cloudflareAccountId: '', cloudflareModel: '@cf/meta/llama-3.1-8b-instruct'
};

export function selectAutoCutTargets(questions: ListeningQuestion[], mode: BoundaryAutomation['mode']) {
  if (mode === 'full-auto') return questions;
  if (mode === 'manual') return [];
  return questions.filter(question => question.confidence >= 0.78 && !question.flags.includes('DURATION_OUTLIER'));
}

async function finalizeTranscript(jobId: string, sourceWav: string, inputSegments: TranscriptSegment[], source: 'caption' | 'whisper', automation: BoundaryAutomation) {
  const segments = normalizeTranscriptSegments(inputSegments);
  progress(jobId, { stage: 'split', percent: 50, agent: 'Boundary Map Agent', message: `Cleaning rolling captions and analyzing boundaries. ${inputSegments.length} raw → ${segments.length} evidence segments.` });
  const duration = await durationSeconds(sourceWav);
  const audioEvidence = await detectSilenceBoundaries(sourceWav);
  const markers = markerCount(segments);
  let questions = splitIntoTwenty(segments, duration, audioEvidence);
  const range = detectQuestionRange(segments);
  progress(jobId, { stage: 'split', percent: 54, agent: 'Boundary Agent Orchestrator', message: automation.mode === 'manual' ? 'Manual Mode: deterministic map ready; remote agents are intentionally skipped.' : 'Validating the deterministic map with Gemini → NVIDIA → Cloudflare fallback.' });
  const agent = await runBoundaryAgentFallback(segments, questions, duration, automation);
  if (agent.proposals) questions = applyBoundaryProposals(questions, segments, duration, agent.proposals);
  for (const attempt of agent.attempts) warn(jobId, `Boundary agent fallback: ${attempt}`);
  if (markers < 15) {
    warn(jobId, `${markers}/20 trusted number/range anchors were detected. Audio silence and section-aware interpolation repaired the remaining boundaries.`);
  }
  const cutTargets = selectAutoCutTargets(questions, automation.mode);
  const reviewCount = questions.length - cutTargets.length;
  updateJob(jobId, {
    transcript: segments,
    transcriptSource: source,
    questions,
    sourceAudioUrl: 'source.wav',
    processingMode: automation.mode,
    boundaryAgent: automation.mode === 'manual' ? 'manual' : agent.provider,
    sourceQuestionRange: range,
    autoCutCount: 0,
    reviewCount
  });
  if (cutTargets.length) {
    progress(jobId, { stage: 'clip', percent: 58, agent: 'Audio Split Agent', message: `${automation.mode === 'full-auto' ? 'Full Auto' : 'Safe Auto'}: cutting ${cutTargets.length}/20 validated source clips.` });
    await cutQuestionClips(sourceWav, cutTargets, jobDir(jobId), q => {
      const position = Math.max(1, cutTargets.findIndex(question => question.number === q) + 1);
      progress(jobId, { stage: 'clip', percent: 58 + Math.round(position / cutTargets.length * 20), agent: 'Audio Split Agent', question: q, message: `Cutting Q${String(q).padStart(2, '0')} (source Q${questions[q - 1]?.sourceNumber ?? q}).` });
    });
  } else {
    skipStages(jobId, ['clip']);
  }
  updateJob(jobId, { questions, autoCutCount: cutTargets.length, reviewCount });
  const modeMessage = automation.mode === 'full-auto'
    ? `Full Auto complete: agent validated and cut all 20 questions without approval.`
    : automation.mode === 'safe-auto'
      ? `Safe Auto complete: ${cutTargets.length} high-confidence clips cut; ${reviewCount} uncertain questions remain for review.`
      : 'Manual map ready: review all boundaries, then use Approve Map & Cut Audio.';
  progress(jobId, { stage: 'ready', percent: automation.mode === 'manual' ? 70 : 80, agent: 'Controller', message: `${modeMessage} Source Q${range.start}–Q${range.end} mapped to output Q1–Q20.`, level: automation.mode === 'full-auto' || reviewCount === 0 ? 'success' : 'warn' });
}

export async function runYoutubePipeline(jobId: string, url: string, access: YoutubeAccess, automation: BoundaryAutomation = DEFAULT_AUTOMATION) {
  try {
    const dir = jobDir(jobId);
    await fs.mkdir(dir, { recursive: true });
    progress(jobId, { stage: 'validate', percent: 3, agent: 'Controller', message: 'Validating the YouTube URL and access mode.' });
    validateYoutubeUrl(url);
    progress(jobId, { stage: 'download', percent: 6, agent: 'Downloader Agent', message: 'Checking yt-dlp and reading YouTube metadata.' });
    const metadata = await inspectYoutube(url, access);
    updateJob(jobId, { sourceLabel: metadata.title || url });
    progress(jobId, { stage: 'download', percent: 9, agent: 'Downloader Agent', message: 'Trying timestamped Korean captions before audio transcription.' });
    const captionAttempt = await fetchYoutubeCaptions(url, dir, access);
    if (captionAttempt.warning) warn(jobId, `Korean caption request was unavailable; Whisper will be used if audio download succeeds. yt-dlp: ${captionAttempt.warning.slice(-900)}`);
    const caption = await loadBestCaption(dir);
    progress(jobId, { stage: 'download', percent: 14, agent: 'Downloader Agent', message: caption ? `Timestamped captions found (${caption.segments.length} segments). Downloading source audio once.` : 'No usable captions found. Downloading audio for local Whisper transcription.' });
    const source = await downloadYoutubeAudio(url, dir, access, metadata);
    progress(jobId, { stage: 'normalize', percent: 25, agent: 'Audio Agent', message: 'Normalizing source to 16 kHz mono WAV.' });
    const sourceWav = path.join(dir, 'source.wav');
    await normalizeAudio(source.inputPath, sourceWav);
    if (caption) {
      progress(jobId, { stage: 'transcribe', percent: 40, agent: 'Transcript Agent', message: 'Using local YouTube caption timestamps. Whisper is not needed for this source.', level: 'success' });
      await finalizeTranscript(jobId, sourceWav, caption.segments, 'caption', automation);
    } else {
      progress(jobId, { stage: 'transcribe', percent: 34, agent: 'Transcript Agent', message: 'Running local Whisper Korean transcription with timestamps.' });
      const segments = await transcribeWithWhisper(sourceWav, dir);
      progress(jobId, { stage: 'transcribe', percent: 45, agent: 'Transcript Agent', message: `Whisper completed: ${segments.length} segments.`, level: 'success' });
      await finalizeTranscript(jobId, sourceWav, segments, 'whisper', automation);
    }
  } catch (error) {
    await fail(jobId, diagnosticFrom(error, { code: 'PIPELINE-YOUTUBE', agent: 'Controller', stage: 'youtube', fix: 'Open the exact error details, apply the suggested fix, then run the source again.' }));
  }
}

export async function runUploadPipeline(jobId: string, inputPath: string, automation: BoundaryAutomation = DEFAULT_AUTOMATION) {
  try {
    const dir = jobDir(jobId);
    progress(jobId, { stage: 'validate', percent: 4, agent: 'Controller', message: 'Validating uploaded audio/video file.' });
    skipStages(jobId, ['download']);
    const sourceWav = path.join(dir, 'source.wav');
    progress(jobId, { stage: 'normalize', percent: 18, agent: 'Audio Agent', message: 'Extracting and normalizing uploaded audio.' });
    await normalizeAudio(inputPath, sourceWav);
    progress(jobId, { stage: 'transcribe', percent: 32, agent: 'Transcript Agent', message: 'Running local Whisper Korean transcription.' });
    const segments = await transcribeWithWhisper(sourceWav, dir);
    progress(jobId, { stage: 'transcribe', percent: 45, agent: 'Transcript Agent', message: `Whisper completed: ${segments.length} segments.`, level: 'success' });
    await finalizeTranscript(jobId, sourceWav, segments, 'whisper', automation);
  } catch (error) {
    await fail(jobId, diagnosticFrom(error, { code: 'PIPELINE-UPLOAD', agent: 'Controller', stage: 'upload', fix: 'Verify FFmpeg/Whisper in Tools, then retry the file.' }));
  }
}

function numberedTextBlocks(raw: string) {
  const text = raw.replace(/\r/g, '');
  const regex = /(?:^|\n)\s*(?:Q\s*)?(\d{1,2})\s*(?:번|[.):])\s*/gim;
  const matches = [...text.matchAll(regex)].filter(m => Number(m[1]) >= 1 && Number(m[1]) <= 20);
  if (!matches.length) return [] as { number: number; text: string }[];
  return matches.map((m, index) => ({
    number: Number(m[1]),
    text: text.slice((m.index ?? 0) + m[0].length, index + 1 < matches.length ? matches[index + 1].index : text.length).trim()
  }));
}

export async function runTextPipeline(jobId: string, raw: string) {
  try {
    progress(jobId, { stage: 'validate', percent: 10, agent: 'Text Agent', message: 'Reading numbered Korean listening scripts.' });
    const blocks = numberedTextBlocks(raw);
    if (!blocks.length) throw new Error('No Q1/Q2… or 1번/2번… numbered blocks were found. Use Custom Voice for a single unnumbered script.');
    const byNumber = new Map(blocks.map(b => [b.number, b.text]));
    const questions: ListeningQuestion[] = Array.from({ length: 20 }, (_, i) => {
      const number = i + 1; const text = byNumber.get(number) ?? '';
      return { number, sourceNumber: number, start: 0, end: 0, confidence: text ? 1 : 0, boundarySource: 'text', type: 'unknown', transcript: text, script: text, questionText: '', choices: [], correctAnswerIndex: null, sourceAudioUrl: null, ttsAudioUrl: null, flags: text ? [] : ['MISSING_TEXT'] };
    });
    const segments: TranscriptSegment[] = blocks.map((b, i) => ({ start: i, end: i + 0.9, text: `${b.number}번 ${b.text}`, source: 'text' }));
    updateJob(jobId, { transcriptSource: 'text', transcript: segments, questions });
    skipStages(jobId, ['download', 'normalize', 'transcript', 'split', 'clip']);
    progress(jobId, { stage: 'ready', percent: 80, agent: 'Text Agent', message: `${blocks.length}/20 numbered scripts loaded. Configure voices and Generate All Voice.`, level: blocks.length === 20 ? 'success' : 'warn' });
  } catch (error) {
    await fail(jobId, diagnosticFrom(error, { code: 'TEXT-PARSE', agent: 'Text Agent', stage: 'text', fix: 'Use Q1:, Q2: … Q20: labels, or use Custom Voice for a single script.' }));
  }
}
