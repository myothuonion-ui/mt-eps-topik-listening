import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import PDFDocument from 'pdfkit';
import type { ListeningJob } from '../../src/shared.js';
import { AppError } from '../core/errors.js';
import { concatAudio } from './audio.js';

function qName(n: number) { return `Q${String(n).padStart(2, '0')}`; }

async function resolveAudio(jobDir: string, q: ListeningJob['questions'][number]) {
  const tts = path.join(jobDir, 'tts', `${qName(q.number)}.mp3`);
  const source = path.join(jobDir, 'clips', `${qName(q.number)}-source.mp3`);
  try { await fsp.access(tts); return tts; } catch {}
  try { await fsp.access(source); return source; } catch {}
  return null;
}

async function answerPdf(job: ListeningJob, file: string) {
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);
    doc.fontSize(18).text('MT EPS TOPIK Listening - Answer Sheet');
    doc.moveDown();
    doc.fontSize(10).text(`Job: ${job.id}`);
    doc.text(`Source: ${job.sourceLabel}`);
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
  const outDir = path.join(jobDir, 'export');
  const audioDir = path.join(outDir, 'Audio');
  const transcriptDir = path.join(outDir, 'Transcript');
  const dataDir = path.join(outDir, 'Data');
  const pdfDir = path.join(outDir, 'PDF');
  await Promise.all([audioDir, transcriptDir, dataDir, pdfDir].map(d => fsp.mkdir(d, { recursive: true })));

  const chosenAudio: string[] = [];
  for (const q of job.questions) {
    const audio = await resolveAudio(jobDir, q);
    if (!audio) continue;
    const target = path.join(audioDir, `${qName(q.number)}.mp3`);
    await fsp.copyFile(audio, target);
    chosenAudio.push(target);
  }
  if (!chosenAudio.length) throw new AppError({ code: 'EXPORT-NO-AUDIO', agent: 'Export Agent', stage: 'export', reason: 'No question audio is available for export.', fix: 'Cut source audio or Generate Voice first, then export again.' });

  const publicQuestions = job.questions.map(q => ({
    number: q.number, type: q.type, start: q.start, end: q.end, confidence: q.confidence, boundarySource: q.boundarySource,
    transcript: q.transcript, script: q.script, questionText: q.questionText, choices: q.choices, correctAnswerIndex: q.correctAnswerIndex, flags: q.flags,
    audio: `Audio/${qName(q.number)}.mp3`
  }));
  await fsp.writeFile(path.join(dataDir, 'questions.json'), JSON.stringify(publicQuestions, null, 2), 'utf8');
  await fsp.writeFile(path.join(dataDir, 'job.json'), JSON.stringify({ id: job.id, source: job.sourceLabel, transcriptSource: job.transcriptSource, warnings: job.warnings }, null, 2), 'utf8');
  await fsp.writeFile(path.join(transcriptDir, 'full-transcript.txt'), job.transcript.map(s => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`).join('\n'), 'utf8');
  await fsp.writeFile(path.join(transcriptDir, 'question-scripts.txt'), job.questions.map(q => `${qName(q.number)} [${q.start.toFixed(2)}-${q.end.toFixed(2)}]\n${q.script}\n`).join('\n'), 'utf8');
  await answerPdf(job, path.join(pdfDir, 'answer-sheet.pdf'));
  await concatAudio(chosenAudio, path.join(outDir, 'Full_Listening_Test.mp3'), outDir, 750);

  const zipPath = path.join(jobDir, `EPS_Listening_${job.id}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const zip = archiver('zip', { zlib: { level: 7 } });
    output.on('close', () => resolve()); output.on('error', reject); zip.on('error', reject);
    zip.pipe(output); zip.directory(outDir, false); void zip.finalize();
  });
  return zipPath;
}
