import fs from 'node:fs/promises';
import path from 'node:path';
import type { ListeningQuestion, VoiceProfile } from '../../src/shared.js';
import { AppError } from '../core/errors.js';
import { concatAudio } from './audio.js';
import { commandAvailable, ffmpegCommand, run } from './tools.js';

export type SystemVoice = { name: string; culture: string; gender: string };

export async function listSystemVoices(): Promise<SystemVoice[]> {
  if (process.platform !== 'win32' || !(await commandAvailable('powershell', ['-NoProfile', '-Command', '$true']))) return [];
  const command = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name + '|' + $_.VoiceInfo.Gender }; $s.Dispose()`;
  const result = await run('powershell', ['-NoProfile', '-Command', command], { timeoutMs: 15_000, allowFailure: true });
  if (result.code !== 0) return [];
  return result.stdout.split(/\r?\n/).map(row => row.trim()).filter(Boolean).map(row => {
    const [name, culture = '', gender = ''] = row.split('|'); return { name, culture, gender };
  });
}

function voiceForSpeaker(label: string, profile: VoiceProfile) {
  if (/남자|male|man/i.test(label)) return profile.maleVoice || profile.narratorVoice;
  if (/여자|female|woman/i.test(label)) return profile.femaleVoice || profile.narratorVoice;
  return profile.narratorVoice || profile.femaleVoice || profile.maleVoice;
}

function scriptLines(script: string) {
  const rows = script.replace(/\r/g, '').split(/\n+/).map(x => x.trim()).filter(Boolean);
  if (!rows.length) return [];
  return rows.map(row => {
    const m = row.match(/^(남자|여자|남|여|안내|나레이션|narrator|male|female)\s*[:：-]\s*(.+)$/i);
    return m ? { speaker: m[1], text: m[2].trim() } : { speaker: 'narrator', text: row };
  });
}

async function sapiToWav(text: string, output: string, voice: string, rate: number, volume: number, workDir: string, index: number) {
  if (process.platform !== 'win32') throw new AppError({ code: 'TTS-WINDOWS', agent: 'Voice Agent', stage: 'tts', reason: 'The built-in local TTS provider currently requires Windows.', fix: 'Run the app on Windows, or keep using source audio clips.' });
  const textFile = path.join(workDir, `_tts-${index}.txt`);
  const psFile = path.join(workDir, `_tts-${index}.ps1`);
  await fs.writeFile(textFile, text, 'utf8');
  const ps = `param([string]$TextFile,[string]$OutputFile,[string]$Voice,[int]$Rate,[int]$Volume)\nAdd-Type -AssemblyName System.Speech\n$s=New-Object System.Speech.Synthesis.SpeechSynthesizer\nif ($Voice -and $Voice.Trim().Length -gt 0) { try { $s.SelectVoice($Voice) } catch {} }\n$s.Rate=[Math]::Max(-10,[Math]::Min(10,$Rate))\n$s.Volume=[Math]::Max(0,[Math]::Min(100,$Volume))\n$text=Get-Content -Raw -Encoding UTF8 $TextFile\n$s.SetOutputToWaveFile($OutputFile)\n$s.Speak($text)\n$s.Dispose()\n`;
  await fs.writeFile(psFile, `\uFEFF${ps}`, 'utf8');
  const result = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, '-TextFile', textFile, '-OutputFile', output, '-Voice', voice, '-Rate', String(rate), '-Volume', String(volume)], { timeoutMs: 3 * 60_000, allowFailure: true });
  if (result.code !== 0) throw new AppError({ code: 'TTS-SAPI', agent: 'Voice Agent', stage: 'tts', reason: 'Windows Speech could not generate the requested voice line.', fix: 'Choose an installed Korean Windows voice in Voice Studio and retry.', detail: result.stderr.slice(-3500) });
  return output;
}

async function pitchProcess(input: string, output: string, pitch: number) {
  if (!pitch) { await fs.copyFile(input, output); return output; }
  const ffmpeg = await ffmpegCommand();
  const factor = Math.pow(2, pitch / 12);
  const tempo = 1 / factor;
  const filter = `asetrate=44100*${factor.toFixed(6)},aresample=44100,atempo=${tempo.toFixed(6)}`;
  const result = await run(ffmpeg, ['-y', '-i', input, '-af', filter, output], { timeoutMs: 60_000, allowFailure: true });
  if (result.code !== 0) throw new AppError({ code: 'TTS-PITCH', agent: 'Voice Agent', stage: 'tts', reason: 'FFmpeg could not apply the requested pitch.', fix: 'Set Pitch to 0 and retry, or verify FFmpeg installation.', detail: result.stderr.slice(-2500) });
  return output;
}

export async function generateQuestionTts(question: ListeningQuestion, profile: VoiceProfile, jobDir: string) {
  const script = (question.script || question.transcript || question.questionText).trim();
  if (!script) throw new AppError({ code: 'TTS-NO-SCRIPT', agent: 'Voice Agent', stage: 'tts', reason: `Q${question.number} has no script to synthesize.`, fix: 'Enter/edit the Korean script first, then Generate Voice.' });
  const lines = scriptLines(script);
  const dir = path.join(jobDir, 'tts', `Q${String(question.number).padStart(2, '0')}`);
  await fs.mkdir(dir, { recursive: true });
  const mp3s: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = path.join(dir, `line-${i + 1}-raw.wav`);
    const pitched = path.join(dir, `line-${i + 1}.wav`);
    await sapiToWav(lines[i].text, raw, voiceForSpeaker(lines[i].speaker, profile), profile.rate, profile.volume, dir, i + 1);
    await pitchProcess(raw, pitched, profile.pitch);
    const mp3 = path.join(dir, `line-${i + 1}.mp3`);
    const ffmpeg = await ffmpegCommand();
    await run(ffmpeg, ['-y', '-i', pitched, '-ar', '44100', '-ac', '1', '-b:a', '128k', mp3], { timeoutMs: 60_000 });
    mp3s.push(mp3);
  }
  const output = path.join(jobDir, 'tts', `Q${String(question.number).padStart(2, '0')}.mp3`);
  await concatAudio(mp3s, output, dir, profile.pauseMs);
  question.ttsAudioUrl = `tts/${path.basename(output)}`;
  return question;
}
