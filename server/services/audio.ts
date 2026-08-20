import fs from 'node:fs/promises';
import path from 'node:path';
import type { ListeningQuestion } from '../../src/shared.js';
import { AppError } from '../core/errors.js';
import { ffmpegCommand, ffprobeCommand, run } from './tools.js';

export async function normalizeAudio(inputPath: string, outputPath: string) {
  const ffmpeg = await ffmpegCommand();
  const result = await run(ffmpeg, ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath], { timeoutMs: 30 * 60_000, allowFailure: true });
  if (result.code !== 0) throw new AppError({ code: 'AUDIO-NORMALIZE', agent: 'Audio Agent', stage: 'normalize', reason: 'FFmpeg could not normalize the source into 16 kHz mono WAV.', fix: 'Check that the source file contains an audio stream and that FFmpeg is installed.', detail: result.stderr.slice(-4000) });
  return outputPath;
}

export async function durationSeconds(inputPath: string) {
  const ffprobe = await ffprobeCommand();
  const result = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath], { timeoutMs: 20_000, allowFailure: true });
  const value = Number(result.stdout.trim());
  if (!Number.isFinite(value) || value <= 0) throw new AppError({ code: 'AUDIO-DURATION', agent: 'Audio Agent', stage: 'normalize', reason: 'Could not determine source audio duration.', fix: 'Check the source file with FFmpeg/FFprobe and retry.', detail: result.stderr.slice(-2500) });
  return value;
}

export async function cutQuestionClips(sourceWav: string, questions: ListeningQuestion[], jobDir: string, onQuestion?: (q: number) => void) {
  const ffmpeg = await ffmpegCommand();
  const clips = path.join(jobDir, 'clips');
  await fs.mkdir(clips, { recursive: true });
  for (const q of questions) {
    onQuestion?.(q.number);
    const output = path.join(clips, `Q${String(q.number).padStart(2, '0')}-source.mp3`);
    const duration = Math.max(0.5, q.end - q.start);
    const result = await run(ffmpeg, ['-y', '-ss', q.start.toFixed(3), '-t', duration.toFixed(3), '-i', sourceWav, '-ac', '1', '-ar', '44100', '-b:a', '128k', output], { timeoutMs: 3 * 60_000, allowFailure: true });
    if (result.code !== 0) throw new AppError({ code: 'AUDIO-CUT', agent: 'Audio Split Agent', stage: 'clip', reason: `FFmpeg failed while cutting Q${q.number}.`, fix: 'Check the Q start/end timestamps in the editor and retry Cut Audio.', detail: result.stderr.slice(-3500) });
    q.sourceAudioUrl = `clips/${path.basename(output)}`;
  }
  return questions;
}

export async function recutQuestion(sourceWav: string, question: ListeningQuestion, jobDir: string) {
  await cutQuestionClips(sourceWav, [question], jobDir);
  return question;
}

export async function makeSilence(file: string, ms: number) {
  const ffmpeg = await ffmpegCommand();
  const seconds = Math.max(0.05, ms / 1000);
  await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', seconds.toFixed(3), '-b:a', '128k', file], { timeoutMs: 30_000 });
  return file;
}

export async function concatAudio(files: string[], output: string, workDir: string, pauseMs = 650) {
  if (!files.length) throw new AppError({ code: 'AUDIO-CONCAT-EMPTY', agent: 'Export Agent', stage: 'export', reason: 'There are no question audio files to combine.', fix: 'Generate or cut at least one question audio file before exporting.' });
  const ffmpeg = await ffmpegCommand();
  const silence = path.join(workDir, '_silence.mp3');
  await makeSilence(silence, pauseMs);
  const concatList = path.join(workDir, '_concat.txt');
  const rows: string[] = [];
  files.forEach((file, index) => {
    rows.push(`file '${file.replace(/'/g, "'\\''")}'`);
    if (index < files.length - 1) rows.push(`file '${silence.replace(/'/g, "'\\''")}'`);
  });
  await fs.writeFile(concatList, rows.join('\n'), 'utf8');
  const result = await run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c:a', 'libmp3lame', '-b:a', '128k', output], { cwd: workDir, timeoutMs: 10 * 60_000, allowFailure: true });
  if (result.code !== 0) throw new AppError({ code: 'AUDIO-CONCAT', agent: 'Export Agent', stage: 'export', reason: 'FFmpeg could not combine the final listening audio.', fix: 'Check the individual Q audio files and retry Export.', detail: result.stderr.slice(-3500) });
  return output;
}
