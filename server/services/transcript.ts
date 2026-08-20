import fs from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptSegment } from '../../src/shared.js';
import { AppError } from '../core/errors.js';
import { run, whisperCommand } from './tools.js';

function vttTime(value: string) {
  const p = value.trim().replace(',', '.').split(':').map(Number);
  if (p.some(n => Number.isNaN(n))) return 0;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return p[0] * 60 + p[1];
}

function cleanCaptionText(text: string) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseVtt(raw: string): TranscriptSegment[] {
  const lines = raw.replace(/\r/g, '').split('\n');
  const out: TranscriptSegment[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('-->')) continue;
    const [left, rightRaw] = lines[i].split('-->');
    const right = rightRaw.trim().split(/\s+/)[0];
    const start = vttTime(left);
    const end = vttTime(right);
    const text: string[] = [];
    i += 1;
    while (i < lines.length && lines[i].trim()) { text.push(lines[i]); i += 1; }
    const cleaned = cleanCaptionText(text.join(' '));
    if (!cleaned || end <= start) continue;
    const previous = out[out.length - 1];
    if (previous && previous.text === cleaned && Math.abs(previous.end - start) < 0.8) previous.end = end;
    else out.push({ start, end, text: cleaned, source: 'caption' });
  }
  return out;
}

export async function loadBestCaption(jobDir: string) {
  const files = await fs.readdir(jobDir).catch(() => [] as string[]);
  const candidates = files.filter(name => /\.vtt$/i.test(name)).sort((a, b) => {
    const score = (name: string) => /\.ko(?:[-_.]|$)/i.test(name) ? 0 : /ko/i.test(name) ? 1 : /en/i.test(name) ? 2 : 3;
    return score(a) - score(b);
  });
  for (const name of candidates) {
    const raw = await fs.readFile(path.join(jobDir, name), 'utf8');
    const segments = parseVtt(raw);
    if (segments.length >= 5) return { file: name, segments };
  }
  return null;
}

export async function transcribeWithWhisper(audioPath: string, jobDir: string, model = process.env.WHISPER_MODEL ?? 'small') {
  const whisper = await whisperCommand();
  await run(whisper, [audioPath, '--language', 'Korean', '--task', 'transcribe', '--model', model, '--output_format', 'json', '--output_dir', jobDir], { timeoutMs: 90 * 60_000 });
  const base = path.basename(audioPath, path.extname(audioPath));
  const jsonPath = path.join(jobDir, `${base}.json`);
  let parsed: any;
  try { parsed = JSON.parse(await fs.readFile(jsonPath, 'utf8')); }
  catch (cause) { throw new AppError({ code: 'WHISPER-OUTPUT', agent: 'Transcript Agent', stage: 'transcribe', reason: 'Whisper finished but its JSON transcript could not be read.', fix: 'Check data/jobs/<job>/ for the Whisper output and retry.', cause }); }
  const segments: TranscriptSegment[] = Array.isArray(parsed?.segments) ? parsed.segments.flatMap((s: any) => {
    const start = Number(s.start); const end = Number(s.end); const text = String(s.text ?? '').trim();
    return Number.isFinite(start) && Number.isFinite(end) && end > start && text ? [{ start, end, text, source: 'whisper' as const }] : [];
  }) : [];
  if (!segments.length) throw new AppError({ code: 'WHISPER-EMPTY', agent: 'Transcript Agent', stage: 'transcribe', reason: 'Whisper produced no usable Korean transcript segments.', fix: 'Check that the source contains audible speech and retry with a larger Whisper model.' });
  return segments;
}
