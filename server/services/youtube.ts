import fs from 'node:fs/promises';
import path from 'node:path';
import type { YoutubeAccess } from '../../src/shared.js';
import { AppError, sanitizeSecrets } from '../core/errors.js';
import { poTokenProviderArgs, poTokenProviderStatus, runYtDlp } from './tools.js';

export type YoutubePrepared = { title: string; duration: number | null; inputPath: string };
export type YoutubeMetadata = { title: string; duration: number | null; id: string; webpageUrl: string };
export type YoutubeFailurePhase = 'metadata' | 'captions' | 'audio' | 'access';
export type YoutubeFailureCode = 'YT-403-POT' | 'YT-403-ACCESS' | 'YT-LOGIN-REQUIRED' | 'YT-PRIVATE' | 'YT-GEO' | 'YT-FORMAT' | 'YT-COOKIE' | 'YT-PROVIDER-MISSING' | 'YT-DOWNLOAD-UNKNOWN';

export function validateYoutubeUrl(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch {
    throw new AppError({ code: 'YT-URL', agent: 'Downloader Agent', stage: 'YouTube Validation', reason: 'The source is not a valid URL.', fix: 'Paste a complete youtube.com or youtu.be video URL.', provider: 'yt-dlp', retryable: false, source: url });
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) {
    throw new AppError({ code: 'YT-URL', agent: 'Downloader Agent', stage: 'YouTube Validation', reason: 'The URL is not hosted by YouTube.', fix: 'Paste a youtube.com or youtu.be video URL.', provider: 'yt-dlp', retryable: false, source: url });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AppError({ code: 'YT-URL', agent: 'Downloader Agent', stage: 'YouTube Validation', reason: 'Only HTTP/HTTPS YouTube URLs are supported.', fix: 'Paste the normal browser URL for the video.', provider: 'yt-dlp', retryable: false, source: url });
  }
  return parsed.toString();
}

export function youtubeAccessArgs(access: YoutubeAccess) {
  return access.mode === 'browser' ? ['--cookies-from-browser', access.browser] : [];
}

export function classifyYoutubeFailure(raw: string, input: { phase: YoutubeFailurePhase; providerReady: boolean; exitCode?: number | null }) {
  const detail = sanitizeSecrets(raw).slice(-6000);
  const lower = detail.toLowerCase();
  const http403 = /(?:http error 403|http 403|403 forbidden|status(?: code)? 403)/i.test(detail);
  let code: YoutubeFailureCode = 'YT-DOWNLOAD-UNKNOWN';
  let reason = 'yt-dlp could not complete the YouTube request.';
  let fix = 'Open Technical details, verify the video in a browser, update yt-dlp, and retry.';
  let retryable = true;

  if (/private video|video is private|members-only|join this channel/.test(lower)) {
    code = 'YT-PRIVATE'; reason = 'The YouTube video is private or restricted to channel members.'; fix = 'Use a video you can access, or explicitly enable Use browser session with a signed-in browser profile that has permission.'; retryable = false;
  } else if (/not available in your country|geo(?:graphic)? restriction|blocked in your country|geo-restricted/.test(lower)) {
    code = 'YT-GEO'; reason = 'YouTube reports that this video is unavailable in the current region.'; fix = 'Use a source available in your region or upload a legally obtained local audio/video file.'; retryable = false;
  } else if (/sign in to confirm|login required|please sign in|age-restricted|confirm your age/.test(lower)) {
    code = 'YT-LOGIN-REQUIRED'; reason = 'YouTube requires a signed-in session for this video.'; fix = 'Select Use browser session, choose the browser where YouTube is signed in, click Test Access, then retry.'; retryable = false;
  } else if (/could not copy.*cookie|failed to decrypt.*cookie|cookie database|cookies.*locked|cookies.*not found/.test(lower)) {
    code = 'YT-COOKIE'; reason = 'yt-dlp could not read the explicitly selected browser session.'; fix = 'Close the selected browser completely, verify its profile can play the video, then Test Access again. You can switch back to Auto / Public.';
  } else if (/no .*po token provider available|po token provider.*(?:missing|unavailable|not found)|provider.*po token.*unavailable/.test(lower) && !http403) {
    code = 'YT-PROVIDER-MISSING'; reason = 'yt-dlp needs a PO Token provider, but no usable provider is installed/running.'; fix = 'Run powershell -File scripts\\Setup-Tools.ps1 -InstallPoTokenProvider, restart the launcher, confirm PO Token Provider: Ready, and retry.'; retryable = false;
  } else if (http403 && input.phase === 'audio' && (/\bpo token\b|\bgvs\b|missing a url|pot provider/.test(lower) || !input.providerReady)) {
    code = 'YT-403-POT'; reason = 'YouTube rejected the media request because the selected player client requires a valid GVS PO Token.'; fix = input.providerReady
      ? 'The provider is detected but the token was rejected. Restart/update the provider and yt-dlp, then retry.'
      : 'Install/enable the supported yt-dlp PO Token provider and retry: powershell -File scripts\\Setup-Tools.ps1 -InstallPoTokenProvider.';
  } else if (http403) {
    code = 'YT-403-ACCESS'; reason = 'YouTube returned HTTP 403 for this video or network identity.'; fix = 'Verify the video plays in a browser. For an account-restricted video, explicitly enable Use browser session and click Test Access.';
  } else if (/requested format is not available|no video formats found|format .* not available|only images are available/.test(lower)) {
    code = 'YT-FORMAT'; reason = 'No supported audio format was available for this video.'; fix = 'Update yt-dlp and retry. If the video is a live/premiere stream, wait until processing finishes or upload a local file.';
  }

  return { code, reason, fix, detail, httpStatus: http403 ? 403 : null, retryable, exitCode: input.exitCode ?? null };
}

function youtubeError(raw: string, input: { phase: YoutubeFailurePhase; providerReady: boolean; exitCode?: number | null }) {
  const classified = classifyYoutubeFailure(raw, input);
  return new AppError({
    code: classified.code, agent: 'Downloader Agent',
    stage: input.phase === 'metadata' ? 'YouTube Metadata' : input.phase === 'captions' ? 'YouTube Captions' : input.phase === 'access' ? 'YouTube Access Test' : 'YouTube Audio Download',
    reason: classified.reason, fix: classified.fix, detail: classified.detail,
    provider: 'yt-dlp', httpStatus: classified.httpStatus, tool: 'yt-dlp', exitCode: classified.exitCode, retryable: classified.retryable
  });
}

async function files(jobDir: string) {
  return fs.readdir(jobDir).catch(() => [] as string[]);
}

function commonArgs(access: YoutubeAccess) {
  return ['--no-playlist', '--no-progress', '--newline', '--retries', '3', '--fragment-retries', '3', '--retry-sleep', 'fragment:exp=1:5', ...youtubeAccessArgs(access)];
}

export async function inspectYoutube(url: string, access: YoutubeAccess): Promise<YoutubeMetadata> {
  const safeUrl = validateYoutubeUrl(url);
  const provider = await poTokenProviderStatus();
  const providerArgs = await poTokenProviderArgs();
  const result = await runYtDlp([...commonArgs(access), ...providerArgs, '--skip-download', '--dump-single-json', safeUrl], { timeoutMs: 3 * 60_000, allowFailure: true });
  if (result.code !== 0) throw youtubeError(`${result.stderr}\n${result.stdout}`, { phase: 'metadata', providerReady: provider.status === 'ready', exitCode: result.code });
  let parsed: any;
  try { parsed = JSON.parse(result.stdout); } catch {
    throw new AppError({ code: 'YT-DOWNLOAD-UNKNOWN', agent: 'Downloader Agent', stage: 'YouTube Metadata', reason: 'yt-dlp returned invalid metadata JSON.', fix: 'Update yt-dlp and retry.', detail: sanitizeSecrets(result.stdout.slice(-3000)), provider: 'yt-dlp', tool: 'yt-dlp', exitCode: result.code, retryable: true });
  }
  return {
    title: String(parsed?.title ?? 'YouTube source'),
    duration: Number.isFinite(Number(parsed?.duration)) ? Number(parsed.duration) : null,
    id: String(parsed?.id ?? ''),
    webpageUrl: String(parsed?.webpage_url ?? safeUrl)
  };
}

export async function fetchYoutubeCaptions(url: string, jobDir: string, access: YoutubeAccess) {
  const safeUrl = validateYoutubeUrl(url);
  const providerArgs = await poTokenProviderArgs();
  const result = await runYtDlp([
    ...commonArgs(access), ...providerArgs, '--skip-download', '--write-subs', '--write-auto-subs',
    '--sub-langs', 'ko.*,ko', '--sub-format', 'vtt',
    '-o', path.join(jobDir, 'caption.%(id)s.%(language)s.%(ext)s'), safeUrl
  ], { cwd: jobDir, timeoutMs: 6 * 60_000, allowFailure: true });
  const captionFiles = (await files(jobDir)).filter(name => name.endsWith('.vtt'));
  if (result.code !== 0 && !captionFiles.length) {
    return { files: [], warning: sanitizeSecrets((result.stderr || result.stdout).slice(-2000)) };
  }
  return { files: captionFiles, warning: null };
}

export type YoutubeAudioAttempt = { name: string; args: string[]; requiresProvider: boolean };

export function youtubeAudioAttempts(providerReady: boolean): YoutubeAudioAttempt[] {
  const attempts: YoutubeAudioAttempt[] = [{
    name: 'default-auto', requiresProvider: false,
    args: ['-f', 'bestaudio/best', '--extractor-args', 'youtube:fetch_pot=auto']
  }];
  if (providerReady) attempts.push({
    name: 'mweb-po-token-provider', requiresProvider: true,
    args: ['-f', 'bestaudio/best', '--extractor-args', 'youtube:player_client=mweb;fetch_pot=always']
  });
  attempts.push({
    name: 'web-safari-hls', requiresProvider: false,
    args: ['-f', 'bestaudio[protocol^=m3u8]/best[protocol^=m3u8]', '--extractor-args', 'youtube:player_client=web_safari;fetch_pot=auto']
  });
  return attempts;
}

export async function executeYoutubeAudioAttempts(
  attempts: YoutubeAudioAttempt[],
  execute: (attempt: YoutubeAudioAttempt, index: number) => Promise<{ code: number; stdout: string; stderr: string; file: string | null }>
) {
  const failures: string[] = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const result = await execute(attempt, index);
    if (result.code === 0 && result.file) return { success: true as const, attempt: attempt.name, file: result.file, failures };
    failures.push(`[${attempt.name}] ${result.code === 0 ? 'exit 0 but no media file was created.' : result.stderr || result.stdout}`);
  }
  return { success: false as const, failures };
}

export async function downloadYoutubeAudio(url: string, jobDir: string, access: YoutubeAccess, metadata?: YoutubeMetadata): Promise<YoutubePrepared> {
  const safeUrl = validateYoutubeUrl(url);
  const provider = await poTokenProviderStatus();
  const providerArgs = await poTokenProviderArgs();
  const attempts = youtubeAudioAttempts(provider.status === 'ready');
  const outcome = await executeYoutubeAudioAttempts(attempts, async (attempt, index) => {
    const prefix = `youtube-source-${index + 1}`;
    const result = await runYtDlp([...commonArgs(access), ...attempt.args, ...providerArgs, '--no-part', '-o', path.join(jobDir, `${prefix}.%(ext)s`), safeUrl], { cwd: jobDir, timeoutMs: 35 * 60_000, allowFailure: true });
    const found = result.code === 0 ? (await files(jobDir)).find(name => name.startsWith(`${prefix}.`) && !/\.(?:part|ytdl)$/i.test(name)) ?? null : null;
    return { ...result, file: found ? path.join(jobDir, found) : null };
  });
  if (outcome.success) return { title: metadata?.title ?? 'YouTube source', duration: metadata?.duration ?? null, inputPath: outcome.file };
  throw youtubeError(outcome.failures.join('\n\n').slice(-9000), { phase: 'audio', providerReady: provider.status === 'ready', exitCode: 1 });
}

export async function testYoutubeAccess(url: string, access: YoutubeAccess) {
  const metadata = await inspectYoutube(url, access);
  return { ok: true, title: metadata.title, duration: metadata.duration, mode: access.mode, browser: access.mode === 'browser' ? access.browser : null };
}
