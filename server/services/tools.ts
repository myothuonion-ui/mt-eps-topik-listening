import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AppError, DATA_ROOT, sanitizeSecrets } from '../core/errors.js';
import type { ToolStatus } from '../../src/shared.js';

const TOOLS_DIR = path.join(DATA_ROOT, 'tools');
const YTDLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
let activeYtDlpJobs = 0;
let updateInProgress = false;
let updateBarrier: Promise<void> | null = null;
let releaseUpdateBarrier: (() => void) | null = null;
let latestCache: { value: string | null; expires: number } | null = null;

export async function run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; allowFailure?: boolean } = {}) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback();
    };
    const timeout = options.timeoutMs ? setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new AppError({
        code: 'TOOL-TIMEOUT', agent: 'Tool Runner', stage: 'Tool Execution',
        reason: `${path.basename(command)} timed out after ${options.timeoutMs}ms.`,
        fix: 'Retry the job. If it repeats, check the source file, network, and tool installation.',
        tool: path.basename(command), retryable: true
      })));
    }, options.timeoutMs) : null;
    child.stdout.on('data', d => { stdout += String(d); });
    child.stderr.on('data', d => { stderr += String(d); });
    child.on('error', err => finish(() => reject(err)));
    child.on('close', code => finish(() => {
      const n = code ?? -1;
      if (n !== 0 && !options.allowFailure) {
        reject(new AppError({
          code: 'TOOL-EXIT', agent: 'Tool Runner', stage: 'Tool Execution',
          reason: `${path.basename(command)} exited with code ${n}.`,
          fix: 'Open Diagnostics and check the command output. Re-run Setup Tools if the binary is missing.',
          detail: sanitizeSecrets(stderr.slice(-4000) || stdout.slice(-4000)), tool: path.basename(command), exitCode: n, retryable: true
        }));
      } else resolve({ stdout, stderr, code: n });
    }));
  });
}

export async function commandAvailable(command: string, args = ['--version']) {
  try { return (await run(command, args, { timeoutMs: 7000, allowFailure: true })).code === 0; } catch { return false; }
}

async function exists(file: string) {
  try { await fs.access(file); return true; } catch { return false; }
}

function localYtDlpPath() {
  return path.join(TOOLS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

export async function resolveYtDlp() {
  const local = localYtDlpPath();
  if (await exists(local)) return local;
  if (await commandAvailable('yt-dlp')) return 'yt-dlp';
  return null;
}

async function replaceLocalTool(downloaded: string, target: string) {
  const backup = `${target}.${process.pid}.${randomUUID()}.bak`;
  let movedExisting = false;
  try {
    if (await exists(target)) {
      await fs.rename(target, backup);
      movedExisting = true;
    }
    await fs.rename(downloaded, target);
    if (movedExisting) await fs.rm(backup, { force: true });
  } catch (error) {
    if (movedExisting && !(await exists(target))) await fs.rename(backup, target).catch(() => {});
    throw error;
  } finally {
    await fs.rm(downloaded, { force: true }).catch(() => {});
    await fs.rm(backup, { force: true }).catch(() => {});
  }
}

async function downloadLatestYtDlp() {
  if (process.platform !== 'win32') {
    throw new AppError({ code: 'YTDLP-UPDATE-PLATFORM', agent: 'Tool Manager', stage: 'yt-dlp Update', reason: 'Automatic local yt-dlp updates are currently supported by the Windows launcher.', fix: 'Update yt-dlp with your operating system package manager.', provider: 'yt-dlp', retryable: false });
  }
  if (activeYtDlpJobs > 0) {
    throw new AppError({ code: 'YTDLP-IN-USE', agent: 'Tool Manager', stage: 'yt-dlp Update', reason: `yt-dlp is currently used by ${activeYtDlpJobs} job(s).`, fix: 'Wait for the active YouTube job to finish, then click Update yt-dlp again.', provider: 'yt-dlp', retryable: true });
  }
  if (updateInProgress) {
    throw new AppError({ code: 'YTDLP-UPDATE-RUNNING', agent: 'Tool Manager', stage: 'yt-dlp Update', reason: 'Another yt-dlp update is already running.', fix: 'Wait for the current update to finish.', provider: 'yt-dlp', retryable: true });
  }
  updateInProgress = true;
  updateBarrier = new Promise<void>(resolve => { releaseUpdateBarrier = resolve; });
  await fs.mkdir(TOOLS_DIR, { recursive: true });
  const target = localYtDlpPath();
  const tmp = path.join(TOOLS_DIR, `yt-dlp.${process.pid}.${randomUUID()}.download`);
  try {
    const response = await fetch(YTDLP_RELEASE, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`GitHub release download returned HTTP ${response.status}.`);
    await fs.writeFile(tmp, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
    const check = await run(tmp, ['--version'], { timeoutMs: 20_000, allowFailure: true });
    if (check.code !== 0 || !/^\d{4}\.\d{2}\.\d{2}/.test(check.stdout.trim())) {
      throw new Error(`Downloaded yt-dlp failed validation (exit ${check.code}).`);
    }
    await replaceLocalTool(tmp, target);
    latestCache = { value: check.stdout.trim(), expires: Date.now() + 15 * 60_000 };
    return { command: target, version: check.stdout.trim() };
  } catch (cause) {
    throw new AppError({ code: 'YTDLP-UPDATE-FAILED', agent: 'Tool Manager', stage: 'yt-dlp Update', reason: 'The local yt-dlp update could not be downloaded and validated.', fix: 'Check GitHub access and antivirus quarantine, then retry. The previous executable is preserved.', provider: 'yt-dlp', retryable: true, detail: cause instanceof Error ? cause.message : String(cause), cause });
  } finally {
    updateInProgress = false;
    const release = releaseUpdateBarrier;
    releaseUpdateBarrier = null;
    updateBarrier = null;
    release?.();
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export async function ensureYtDlp() {
  const installed = await resolveYtDlp();
  if (installed) return installed;
  if (process.platform === 'win32') return (await downloadLatestYtDlp()).command;
  throw new AppError({ code: 'YTDLP-MISSING', agent: 'Downloader Agent', stage: 'YouTube Tool Check', reason: 'yt-dlp is not installed.', fix: 'Install yt-dlp, then restart the app.', provider: 'yt-dlp', retryable: false });
}

export async function runYtDlp(args: string[], options: { cwd?: string; timeoutMs?: number; allowFailure?: boolean } = {}) {
  while (updateBarrier) await updateBarrier;
  const command = await ensureYtDlp();
  while (updateBarrier) await updateBarrier;
  activeYtDlpJobs += 1;
  try {
    return await run(command, args, options);
  } finally {
    activeYtDlpJobs = Math.max(0, activeYtDlpJobs - 1);
  }
}

export async function updateYtDlp() {
  return downloadLatestYtDlp();
}

async function installedYtDlpVersion() {
  const command = await resolveYtDlp();
  if (!command) return null;
  const result = await run(command, ['--version'], { timeoutMs: 10_000, allowFailure: true });
  return result.code === 0 ? result.stdout.trim().split(/\s+/)[0] || null : null;
}

async function latestYtDlpVersion() {
  if (latestCache && latestCache.expires > Date.now()) return latestCache.value;
  try {
    const response = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'MT-EPS-Listening-Factory' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { tag_name?: string };
    const value = String(payload.tag_name ?? '').replace(/^v/, '') || null;
    latestCache = { value, expires: Date.now() + 15 * 60_000 };
    return value;
  } catch {
    latestCache = { value: null, expires: Date.now() + 60_000 };
    return null;
  }
}

function versionParts(value: string) {
  return value.split(/[.-]/).map(part => Number(part) || 0);
}

function versionOlder(installed: string, latest: string) {
  const a = versionParts(installed); const b = versionParts(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

async function hasProviderPlugin() {
  const roots = [
    path.join(TOOLS_DIR, 'yt-dlp-plugins'),
    path.join(process.cwd(), 'yt-dlp-plugins'),
    path.join(process.env.APPDATA ?? '', 'yt-dlp', 'plugins'),
    path.join(process.env.APPDATA ?? '', 'yt-dlp-plugins'),
    path.join(process.env.LOCALAPPDATA ?? '', 'yt-dlp', 'plugins')
  ].filter(Boolean);
  for (const root of roots) {
    const names = await fs.readdir(root, { recursive: true }).catch(() => [] as string[]);
    if (names.some(name => /(?:bgutil|pot.provider|get.?pot).*(?:\.zip|\.py)$/i.test(String(name)))) return true;
  }
  const python = await commandAvailable('python', ['-c', 'import importlib.metadata as m; m.version("bgutil-ytdlp-pot-provider")']);
  const py = python || await commandAvailable('py', ['-c', 'import importlib.metadata as m; m.version("bgutil-ytdlp-pot-provider")']);
  return py;
}

function providerScriptCandidates() {
  return [
    path.join(os.homedir(), 'bgutil-ytdlp-pot-provider', 'server', 'build', 'generate_once.js'),
    path.join(TOOLS_DIR, 'bgutil-ytdlp-pot-provider', 'server', 'build', 'generate_once.js')
  ];
}

export async function poTokenProviderArgs() {
  for (const candidate of providerScriptCandidates()) {
    if (await exists(candidate) && await hasProviderPlugin()) return ['--extractor-args', `youtubepot-bgutilscript:script_path=${candidate}`];
  }
  return [] as string[];
}

export async function poTokenProviderStatus(): Promise<ToolStatus['poTokenProvider']> {
  const base = process.env.YTDLP_POT_PROVIDER_URL ?? 'http://127.0.0.1:4416';
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/ping`, { signal: AbortSignal.timeout(1800) });
    if (response.ok && await hasProviderPlugin()) return { status: 'ready', name: 'bgutil:http', detail: `Provider service responding at ${base}; plugin detected.` };
  } catch {}
  const scriptCandidates = providerScriptCandidates();
  if ((await Promise.all(scriptCandidates.map(exists))).some(Boolean) && await hasProviderPlugin()) {
    return { status: 'ready', name: 'bgutil:script-node', detail: 'Provider plugin and compiled local token script detected.' };
  }
  return {
    status: 'missing', name: null,
    detail: 'Optional. Run powershell -File scripts\\Setup-Tools.ps1 -InstallPoTokenProvider when YouTube reports YT-403-POT.'
  };
}

async function localMediaCommand(name: 'ffmpeg' | 'ffprobe') {
  if (await commandAvailable(name, ['-version'])) return name;
  const candidates = [
    path.join(TOOLS_DIR, `${name}.exe`),
    path.join(TOOLS_DIR, 'ffmpeg', 'bin', `${name}.exe`)
  ];
  for (const candidate of candidates) if (await exists(candidate) && await commandAvailable(candidate, ['-version'])) return candidate;
  return null;
}

export async function ffmpegCommand() {
  const command = await localMediaCommand('ffmpeg');
  if (command) return command;
  throw new AppError({ code: 'FFMPEG-MISSING', agent: 'Audio Agent', stage: 'Audio Normalize', reason: 'FFmpeg is not installed or available to the app.', fix: 'Run scripts\\Setup-Tools.ps1, reopen the launcher, and retry.', tool: 'ffmpeg', retryable: false });
}

export async function ffprobeCommand() {
  const command = await localMediaCommand('ffprobe');
  if (command) return command;
  throw new AppError({ code: 'FFPROBE-MISSING', agent: 'Audio Agent', stage: 'Audio Normalize', reason: 'FFprobe is not installed or available to the app.', fix: 'Run scripts\\Setup-Tools.ps1, reopen the launcher, and retry.', tool: 'ffprobe', retryable: false });
}

export async function whisperCommand() {
  if (await commandAvailable('whisper', ['--help'])) return 'whisper';
  throw new AppError({ code: 'WHISPER-MISSING', agent: 'Transcript Agent', stage: 'Korean Transcript', reason: 'No usable Korean captions were found and Whisper is not installed.', fix: 'Run powershell -File scripts\\Setup-Tools.ps1 (without -SkipWhisper). Whisper is only required when Korean captions are unavailable.', tool: 'whisper', retryable: false });
}

export async function toolStatus(): Promise<ToolStatus> {
  const [ffmpeg, ffprobe, installedVersion, latestVersion, whisper, powershell, poTokenProvider] = await Promise.all([
    localMediaCommand('ffmpeg').then(Boolean), localMediaCommand('ffprobe').then(Boolean), installedYtDlpVersion(), latestYtDlpVersion(),
    commandAvailable('whisper', ['--help']),
    process.platform === 'win32' ? commandAvailable('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']) : Promise.resolve(false),
    poTokenProviderStatus()
  ]);
  const status = !installedVersion ? 'missing' : !latestVersion ? 'unknown' : versionOlder(installedVersion, latestVersion) ? 'update-available' : 'current';
  return {
    ffmpeg, ffprobe, ytdlp: Boolean(installedVersion), whisper, powershell,
    ytdlpInfo: { installedVersion, latestVersion, status, activeJobs: activeYtDlpJobs },
    poTokenProvider
  };
}
