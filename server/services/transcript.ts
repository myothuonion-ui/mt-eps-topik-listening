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
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function rollingOverlap(previous: string, current: string) {
  const limit = Math.min(previous.length, current.length);
  for (let size = limit; size >= 4; size -= 1) {
    if (previous.slice(-size) === current.slice(0, size)) return size;
  }
  return 0;
}

/**
 * YouTube auto captions are rolling snapshots: a cue often repeats the prior
 * cue and appends only a few new words. Keep only the spoken delta so marker
 * detection and transcript previews do not see the same answer choice many
 * times. The original timestamps remain the evidence for every retained delta.
 */
export function normalizeTranscriptSegments(input: TranscriptSegment[]) {
  const ordered = [...input]
    .filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const output: TranscriptSegment[] = [];
  let previousRaw = '';
  let previousSource: TranscriptSegment['source'] | null = null;
  for (const segment of ordered) {
    const current = cleanCaptionText(segment.text).replace(/^>+\s*/, '').trim();
    if (!current) continue;
    let delta = current;
    const rollingCaption = segment.source === 'caption' && previousSource === 'caption';
    if (previousRaw && rollingCaption) {
      if (current === previousRaw || previousRaw.startsWith(current) || previousRaw.endsWith(current)) delta = '';
      else if (current.startsWith(previousRaw)) delta = current.slice(previousRaw.length).trim();
      else {
        const overlap = rollingOverlap(previousRaw, current);
        if (overlap >= Math.min(12, Math.max(4, Math.floor(current.length * 0.3)))) delta = current.slice(overlap).trim();
      }
    }
    previousRaw = segment.source === 'caption' ? current : '';
    previousSource = segment.source;
    delta = delta.replace(/^[-–—>.:,\s]+/, '').replace(/\s+/g, ' ').trim();
    if (!delta) {
      const previous = output.at(-1);
      if (previous && segment.start <= previous.end + 0.8) previous.end = Math.max(previous.end, segment.end);
      continue;
    }
    const previous = output.at(-1);
    if (previous && previous.text === delta && segment.start <= previous.end + 0.8) previous.end = Math.max(previous.end, segment.end);
    else output.push({ ...segment, text: delta });
  }
  return output;
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
  return normalizeTranscriptSegments(out);
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
  return normalizeTranscriptSegments(segments);
}
