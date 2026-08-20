import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { ensureYtDlp, run } from './tools.js';

export type YoutubePrepared = {
  title: string;
  duration: number | null;
  inputPath: string;
};

function youtubeLike(url: string) {
  try {
    const u = new URL(url);
    return ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'].includes(u.hostname);
  } catch { return false; }
}

async function files(jobDir: string) {
  return fs.readdir(jobDir).catch(() => [] as string[]);
}

export async function fetchYoutubeCaptions(url: string, jobDir: string) {
  if (!youtubeLike(url)) throw new AppError({ code: 'YT-URL', agent: 'Downloader Agent', stage: 'validate', reason: 'The URL is not a supported YouTube URL.', fix: 'Paste a youtube.com or youtu.be video link.' });
  const ytdlp = await ensureYtDlp();
  const result = await run(ytdlp, [
    '--no-playlist', '--skip-download', '--write-subs', '--write-auto-subs',
    '--sub-langs', 'ko.*,ko,en.*', '--sub-format', 'vtt', '--no-warnings',
    '-o', path.join(jobDir, 'caption.%(id)s.%(language)s.%(ext)s'), url
  ], { cwd: jobDir, timeoutMs: 5 * 60_000, allowFailure: true });
  if (result.code !== 0 && !/subtitles|requested format|not available/i.test(result.stderr)) {
    throw new AppError({ code: 'YT-CAPTION', agent: 'Downloader Agent', stage: 'download', reason: 'yt-dlp could not inspect YouTube captions.', fix: 'Check the video is public/accessible and update yt-dlp. The pipeline can still use Whisper after audio download.', detail: result.stderr.slice(-3500) });
  }
  return (await files(jobDir)).filter(name => name.endsWith('.vtt'));
}

export async function downloadYoutubeAudio(url: string, jobDir: string): Promise<YoutubePrepared> {
  if (!youtubeLike(url)) throw new AppError({ code: 'YT-URL', agent: 'Downloader Agent', stage: 'validate', reason: 'The URL is not a supported YouTube URL.', fix: 'Paste a youtube.com or youtu.be video link.' });
  const ytdlp = await ensureYtDlp();
  const meta = await run(ytdlp, ['--no-playlist', '--dump-single-json', '--no-warnings', url], { timeoutMs: 2 * 60_000, allowFailure: true });
  if (meta.code !== 0) throw new AppError({ code: 'YT-METADATA', agent: 'Downloader Agent', stage: 'download', reason: 'YouTube metadata could not be read.', fix: 'Check that the video is public and playable in your browser, then retry.', detail: meta.stderr.slice(-4000) });
  let parsed: any = {};
  try { parsed = JSON.parse(meta.stdout); } catch {}
  const output = path.join(jobDir, 'youtube-source.%(ext)s');
  const dl = await run(ytdlp, ['--no-playlist', '-f', 'ba/b', '--no-warnings', '-o', output, url], { cwd: jobDir, timeoutMs: 30 * 60_000, allowFailure: true });
  if (dl.code !== 0) throw new AppError({ code: 'YT-DOWNLOAD', agent: 'Downloader Agent', stage: 'download', reason: 'YouTube audio download failed.', fix: 'Check the video, network, and yt-dlp. Run Setup Tools to update yt-dlp if needed.', detail: dl.stderr.slice(-4000) });
  const found = (await files(jobDir)).find(name => /^youtube-source\./i.test(name) && !/\.part$/i.test(name));
  if (!found) throw new AppError({ code: 'YT-NO-AUDIO', agent: 'Downloader Agent', stage: 'download', reason: 'yt-dlp finished without a usable source audio file.', fix: 'Retry after updating yt-dlp, or upload the audio/video file directly.' });
  return { title: String(parsed?.title ?? 'YouTube source'), duration: Number.isFinite(Number(parsed?.duration)) ? Number(parsed.duration) : null, inputPath: path.join(jobDir, found) };
}
