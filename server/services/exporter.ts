import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import PDFDocument from 'pdfkit';
import type { ListeningJob } from '../../src/shared.js';
import { AppError, sanitizeSecrets } from '../core/errors.js';
import { concatAudio } from './audio.js';

function qName(n: number) { return `Q${String(n).padStart(2, '0')}`; }

export async function resolveQuestionAudio(jobDir: string, questionNumber: number) {
  const tts = path.join(jobDir, 'tts', `${qName(questionNumber)}.mp3`);
  const source = path.join(jobDir, 'clips', `${qName(questionNumber)}-source.mp3`);
  try { await fsp.access(tts); return { file: tts, kind: 'tts' as const }; } catch {}
  try { await fsp.access(source); return { file: source, kind: 'source' as const }; } catch {}
  return null;
}

async function answerPdf(job: ListeningJob, file: string) {
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);
    doc.fontSize(18).text('MT EPS TOPIK Listening - Answer Key');
    doc.moveDown();
    doc.fontSize(10).text(`Job: ${job.id}`);
    doc.text(`Source: ${sanitizeSecrets(job.sourceLabel)}`);
    doc.moveDown();
    for (const q of job.questions) {
      const answer = q.correctAnswerIndex === null ? 'Not set' : String(q.correctAnswerIndex + 1);
      doc.text(`${qName(q.number)}   Answer: ${answer}   Type: ${q.type}   ${q.start.toFixed(2)}s-${q.end.toFixed(2)}s`);
    }
    doc.end();
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
}

export async function exportPackage(job: ListeningJob, jobDir: string) {
  const outDir = path.join(jobDir, 'package');
  const audioDir = path.join(outDir, 'audio');
  const sourceDir = path.join(outDir, 'source_audio');
  const transcriptDir = path.join(outDir, 'transcript');
  const dataDir = path.join(outDir, 'data');
  const diagnosticsDir = path.join(outDir, 'diagnostics');
  await Promise.all([audioDir, sourceDir, transcriptDir, dataDir, diagnosticsDir].map(dir => fsp.mkdir(dir, { recursive: true })));

  const chosenAudio: string[] = [];
  const audioKinds = new Map<number, 'tts' | 'source'>();
  for (const q of job.questions) {
    const selected = await resolveQuestionAudio(jobDir, q.number);
    if (selected) {
      const target = path.join(audioDir, `${qName(q.number)}.mp3`);
      await fsp.copyFile(selected.file, target);
      chosenAudio.push(target);
      audioKinds.set(q.number, selected.kind);
    }
    const source = path.join(jobDir, 'clips', `${qName(q.number)}-source.mp3`);
    try { await fsp.copyFile(source, path.join(sourceDir, `${qName(q.number)}-source.mp3`)); } catch {}
  }
  if (!chosenAudio.length) throw new AppError({ code: 'EXPORT-NO-AUDIO', agent: 'Export Agent', stage: 'Final Export', reason: 'No question audio is available for export.', fix: 'Re-cut source audio or Generate Voice for at least one question, then export again.', retryable: true });

  const publicQuestions = job.questions.map(q => ({
    number: q.number, type: q.type, start: q.start, end: q.end, confidence: q.confidence, boundarySource: q.boundarySource,
    transcript: q.transcript, script: q.script, questionText: q.questionText, choices: q.choices, correctAnswerIndex: q.correctAnswerIndex,
    flags: q.flags, audio: audioKinds.has(q.number) ? `audio/${qName(q.number)}.mp3` : null, audioSource: audioKinds.get(q.number) ?? null,
    sourceAudio: q.sourceAudioUrl ? `source_audio/${qName(q.number)}-source.mp3` : null
  }));
  await fsp.writeFile(path.join(dataDir, 'questions.json'), sanitizeSecrets(JSON.stringify(publicQuestions, null, 2)), 'utf8');
  await fsp.writeFile(path.join(transcriptDir, 'transcript.txt'), job.transcript.map(segment => `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}`).join('\n'), 'utf8');
  await fsp.writeFile(path.join(transcriptDir, 'transcript.json'), sanitizeSecrets(JSON.stringify(job.transcript, null, 2)), 'utf8');
  const logRows = job.logs.map(log => JSON.stringify(log));
  if (job.error) logRows.push(JSON.stringify({ type: 'error', ...job.error }));
  await fsp.writeFile(path.join(diagnosticsDir, 'job-log.jsonl'), sanitizeSecrets(logRows.join('\n') + (logRows.length ? '\n' : '')), 'utf8');
  await answerPdf(job, path.join(outDir, 'answer_key.pdf'));
  await concatAudio(chosenAudio, path.join(audioDir, 'full_listening.mp3'), outDir, 750);

  const zipPath = path.join(jobDir, 'MT_EPS_Listening_Set.zip');
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const zip = archiver('zip', { zlib: { level: 7 } });
    output.on('close', () => resolve());
    output.on('error', reject);
    zip.on('error', reject);
    zip.pipe(output);
    zip.directory(outDir, false);
    void zip.finalize();
  });
  return zipPath;
}
