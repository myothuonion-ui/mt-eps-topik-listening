import fs from 'node:fs/promises';
import path from 'node:path';
import type { ListeningQuestion, TranscriptSegment } from '../src/shared.js';
import { diagnosticFrom } from './core/errors.js';
import { fail, jobDir, progress, updateJob, warn } from './core/jobs.js';
import { cutQuestionClips, durationSeconds, normalizeAudio } from './services/audio.js';
import { loadBestCaption, transcribeWithWhisper } from './services/transcript.js';
import { markerCount, splitIntoTwenty } from './services/splitter.js';
import { downloadYoutubeAudio, fetchYoutubeCaptions } from './services/youtube.js';

async function finalizeTranscript(jobId: string, sourceWav: string, segments: TranscriptSegment[], source: 'caption' | 'whisper') {
  progress(jobId, { stage: 'split', percent: 50, agent: 'Question Split Agent', message: `Analyzing transcript boundaries. ${segments.length} timestamped segments loaded.` });
  const duration = await durationSeconds(sourceWav);
  const markers = markerCount(segments);
  const questions = splitIntoTwenty(segments, duration);
  if (markers < 15) {
    warn(jobId, `Only ${markers}/20 explicit question-number anchors were detected. Missing boundaries were interpolated; review timestamps before final export.`);
  }
  updateJob(jobId, { transcript: segments, transcriptSource: source, questions, sourceAudioUrl: 'source.wav' });
  progress(jobId, { stage: 'clip', percent: 58, agent: 'Audio Split Agent', message: 'Cutting Q01-Q20 source audio clips.' });
  await cutQuestionClips(sourceWav, questions, jobDir(jobId), q => {
    progress(jobId, { stage: 'clip', percent: 58 + Math.round(q / 20 * 20), agent: 'Audio Split Agent', question: q, message: `Cutting Q${String(q).padStart(2, '0')} source clip.` });
  });
  updateJob(jobId, { questions });
  progress(jobId, { stage: 'ready', percent: 80, agent: 'Controller', message: `20 listening slots are ready. ${markers}/20 explicit number anchors detected. Review/edit timestamps only where needed.`, level: markers >= 15 ? 'success' : 'warn' });
}

export async function runYoutubePipeline(jobId: string, url: string) {
  try {
    const dir = jobDir(jobId);
    await fs.mkdir(dir, { recursive: true });
    progress(jobId, { stage: 'validate', percent: 3, agent: 'Controller', message: 'Validating YouTube source.' });
    progress(jobId, { stage: 'download', percent: 8, agent: 'Downloader Agent', message: 'Checking YouTube Korean captions first. No AI video analysis is used.' });
    await fetchYoutubeCaptions(url, dir);
    const caption = await loadBestCaption(dir);
    progress(jobId, { stage: 'download', percent: 14, agent: 'Downloader Agent', message: caption ? `Timestamped captions found (${caption.segments.length} segments). Downloading source audio once.` : 'No usable captions found. Downloading audio for local Whisper transcription.' });
    const source = await downloadYoutubeAudio(url, dir);
    updateJob(jobId, { sourceLabel: source.title || url });
    progress(jobId, { stage: 'normalize', percent: 25, agent: 'Audio Agent', message: 'Normalizing source to 16 kHz mono WAV.' });
    const sourceWav = path.join(dir, 'source.wav');
    await normalizeAudio(source.inputPath, sourceWav);
    if (caption) {
      progress(jobId, { stage: 'transcribe', percent: 40, agent: 'Transcript Agent', message: 'Using local YouTube caption timestamps. Whisper is not needed for this source.', level: 'success' });
      await finalizeTranscript(jobId, sourceWav, caption.segments, 'caption');
    } else {
      progress(jobId, { stage: 'transcribe', percent: 34, agent: 'Transcript Agent', message: 'Running local Whisper Korean transcription with timestamps.' });
      const segments = await transcribeWithWhisper(sourceWav, dir);
      progress(jobId, { stage: 'transcribe', percent: 45, agent: 'Transcript Agent', message: `Whisper completed: ${segments.length} segments.`, level: 'success' });
      await finalizeTranscript(jobId, sourceWav, segments, 'whisper');
    }
  } catch (error) {
    await fail(jobId, diagnosticFrom(error, { code: 'PIPELINE-YOUTUBE', agent: 'Controller', stage: 'youtube', fix: 'Open the exact error details, apply the suggested fix, then run the source again.' }));
  }
}

export async function runUploadPipeline(jobId: string, inputPath: string) {
  try {
    const dir = jobDir(jobId);
    progress(jobId, { stage: 'validate', percent: 4, agent: 'Controller', message: 'Validating uploaded audio/video file.' });
    const sourceWav = path.join(dir, 'source.wav');
    progress(jobId, { stage: 'normalize', percent: 18, agent: 'Audio Agent', message: 'Extracting and normalizing uploaded audio.' });
    await normalizeAudio(inputPath, sourceWav);
    progress(jobId, { stage: 'transcribe', percent: 32, agent: 'Transcript Agent', message: 'Running local Whisper Korean transcription.' });
    const segments = await transcribeWithWhisper(sourceWav, dir);
    progress(jobId, { stage: 'transcribe', percent: 45, agent: 'Transcript Agent', message: `Whisper completed: ${segments.length} segments.`, level: 'success' });
    await finalizeTranscript(jobId, sourceWav, segments, 'whisper');
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
      return { number, start: 0, end: 0, confidence: text ? 1 : 0, boundarySource: 'text', type: 'unknown', transcript: text, script: text, questionText: '', choices: [], correctAnswerIndex: null, sourceAudioUrl: null, ttsAudioUrl: null, flags: text ? [] : ['MISSING_TEXT'] };
    });
    const segments: TranscriptSegment[] = blocks.map((b, i) => ({ start: i, end: i + 0.9, text: `${b.number}번 ${b.text}`, source: 'text' }));
    updateJob(jobId, { transcriptSource: 'text', transcript: segments, questions });
    progress(jobId, { stage: 'ready', percent: 80, agent: 'Text Agent', message: `${blocks.length}/20 numbered scripts loaded. Configure voices and Generate All Voice.`, level: blocks.length === 20 ? 'success' : 'warn' });
  } catch (error) {
    await fail(jobId, diagnosticFrom(error, { code: 'TEXT-PARSE', agent: 'Text Agent', stage: 'text', fix: 'Use Q1:, Q2: … Q20: labels, or use Custom Voice for a single script.' }));
  }
}
