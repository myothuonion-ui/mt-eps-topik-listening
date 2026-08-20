import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError, DATA_ROOT } from '../core/errors.js';
import type { ToolStatus } from '../../src/shared.js';

const TOOLS_DIR = path.join(DATA_ROOT, 'tools');

export async function run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; allowFailure?: boolean } = {}) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    const timeout = options.timeoutMs ? setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AppError({ code: 'TOOL-TIMEOUT', agent: 'Tool Runner', stage: 'tool', reason: `${path.basename(command)} timed out after ${options.timeoutMs}ms.`, fix: 'Retry the job. If it repeats, check the source file/network and tool installation.' }));
    }, options.timeoutMs) : null;
    child.stdout.on('data', d => { stdout += String(d); });
    child.stderr.on('data', d => { stderr += String(d); });
    child.on('error', err => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on('close', code => {
      if (timeout) clearTimeout(timeout);
      const n = code ?? -1;
      if (n !== 0 && !options.allowFailure) {
        reject(new AppError({ code: 'TOOL-EXIT', agent: 'Tool Runner', stage: 'tool', reason: `${path.basename(command)} exited with code ${n}.`, fix: 'Open Diagnostics and check the command output. Re-run Setup Tools if the binary is missing.', detail: stderr.slice(-4000) || stdout.slice(-4000) }));
      } else resolve({ stdout, stderr, code: n });
    });
  });
}

export async function commandAvailable(command: string, args = ['--version']) {
  try { return (await run(command, args, { timeoutMs: 7000, allowFailure: true })).code === 0; } catch { return false; }
}

export async function ensureYtDlp() {
  await fs.mkdir(TOOLS_DIR, { recursive: true });
  const local = path.join(TOOLS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  try { await fs.access(local); return local; } catch {}
  if (await commandAvailable('yt-dlp')) return 'yt-dlp';
  if (process.platform !== 'win32') {
    throw new AppError({ code: 'YTDLP-MISSING', agent: 'Downloader Agent', stage: 'download', reason: 'yt-dlp is not installed.', fix: 'Install yt-dlp, then restart the app.' });
  }
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(local, bytes);
    return local;
  } catch (cause) {
    throw new AppError({ code: 'YTDLP-BOOTSTRAP', agent: 'Downloader Agent', stage: 'download', reason: 'Could not download the local yt-dlp tool.', fix: 'Run scripts\\Setup-Tools.ps1 once, then retry.', cause });
  }
}

export async function ffmpegCommand() {
  if (await commandAvailable('ffmpeg', ['-version'])) return 'ffmpeg';
  throw new AppError({ code: 'FFMPEG-MISSING', agent: 'Audio Agent', stage: 'normalize', reason: 'FFmpeg is not available on PATH.', fix: 'Run scripts\\Setup-Tools.ps1, restart the app, and retry.' });
}

export async function ffprobeCommand() {
  if (await commandAvailable('ffprobe', ['-version'])) return 'ffprobe';
  throw new AppError({ code: 'FFPROBE-MISSING', agent: 'Audio Agent', stage: 'normalize', reason: 'FFprobe is not available on PATH.', fix: 'Run scripts\\Setup-Tools.ps1, restart the app, and retry.' });
}

export async function whisperCommand() {
  if (await commandAvailable('whisper', ['--help'])) return 'whisper';
  throw new AppError({ code: 'WHISPER-MISSING', agent: 'Transcript Agent', stage: 'transcribe', reason: 'No Korean captions were found and Whisper is not installed.', fix: 'Run scripts\\Setup-Tools.ps1. It installs openai-whisper when Python is available.' });
}

export async function toolStatus(): Promise<ToolStatus> {
  const [ffmpeg, ffprobe, ytdlpSystem, whisper, powershell] = await Promise.all([
    commandAvailable('ffmpeg', ['-version']), commandAvailable('ffprobe', ['-version']), commandAvailable('yt-dlp'), commandAvailable('whisper', ['--help']), process.platform === 'win32' ? commandAvailable('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']) : Promise.resolve(false)
  ]);
  let localYt = false;
  try { await fs.access(path.join(TOOLS_DIR, 'yt-dlp.exe')); localYt = true; } catch {}
  return { ffmpeg, ffprobe, ytdlp: ytdlpSystem || localYt, whisper, powershell };
}
