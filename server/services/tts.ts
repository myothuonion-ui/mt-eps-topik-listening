import fs from 'node:fs/promises';
import path from 'node:path';
import type { ListeningQuestion, VoiceProfile } from '../../src/shared.js';
import { AppError } from '../core/errors.js';
import { concatAudio } from './audio.js';
import { commandAvailable, ffmpegCommand, run } from './tools.js';

export type SystemVoice = { name: string; culture: string; gender: string };

export const GEMINI_TTS_MODELS = [
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts'
] as const;

export const GEMINI_TTS_VOICES = [
  'Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe',
  'Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar',
  'Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat'
] as const;

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
  if (profile.provider === 'gemini') {
    if (/남자|male|man/i.test(label)) return profile.geminiMaleVoice || profile.geminiNarratorVoice || 'Charon';
    if (/여자|female|woman/i.test(label)) return profile.geminiFemaleVoice || profile.geminiNarratorVoice || 'Kore';
    return profile.geminiNarratorVoice || profile.geminiFemaleVoice || profile.geminiMaleVoice || 'Kore';
  }
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
  if (process.platform !== 'win32') throw new AppError({ code: 'TTS-WINDOWS', agent: 'Voice Agent', stage: 'Windows Local TTS', reason: 'The built-in local TTS provider currently requires Windows.', fix: 'Switch Voice Provider to Gemini, or run the app on Windows.', provider: 'Windows System.Speech', retryable: false });
  const textFile = path.join(workDir, `_tts-${index}.txt`);
  const psFile = path.join(workDir, `_tts-${index}.ps1`);
  await fs.writeFile(textFile, text, 'utf8');
  const ps = `param([string]$TextFile,[string]$OutputFile,[string]$Voice,[int]$Rate,[int]$Volume)\nAdd-Type -AssemblyName System.Speech\n$s=New-Object System.Speech.Synthesis.SpeechSynthesizer\nif ($Voice -and $Voice.Trim().Length -gt 0) { try { $s.SelectVoice($Voice) } catch {} }\n$s.Rate=[Math]::Max(-10,[Math]::Min(10,$Rate))\n$s.Volume=[Math]::Max(0,[Math]::Min(100,$Volume))\n$text=Get-Content -Raw -Encoding UTF8 $TextFile\n$s.SetOutputToWaveFile($OutputFile)\n$s.Speak($text)\n$s.Dispose()\n`;
  await fs.writeFile(psFile, `\uFEFF${ps}`, 'utf8');
  const result = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, '-TextFile', textFile, '-OutputFile', output, '-Voice', voice, '-Rate', String(rate), '-Volume', String(volume)], { timeoutMs: 3 * 60_000, allowFailure: true });
  if (result.code !== 0) throw new AppError({ code: 'TTS-SAPI', agent: 'Voice Agent', stage: 'Windows Local TTS', reason: 'Windows Speech could not generate the requested voice line.', fix: 'Choose an installed Korean Windows voice or switch to Gemini TTS.', detail: result.stderr.slice(-3500), provider: 'Windows System.Speech', tool: 'powershell', exitCode: result.code, retryable: true });
  const size = (await fs.stat(output).catch(() => null))?.size ?? 0;
  if (size <= 46) throw new AppError({ code: 'TTS-WINDOWS-NO-KOREAN-VOICE', agent: 'Voice Agent', stage: 'Windows Local TTS', reason: 'Windows Speech created no audible Korean audio. No compatible Korean System.Speech voice appears to be installed.', fix: 'Windows Settings → Time & language → Language & region → Korean → Language options → install Speech. Restart the app, select that Korean voice, and retry; or use Gemini TTS.', provider: 'Windows System.Speech', tool: 'powershell', retryable: false });
  return output;
}

function googleMessage(payload: any) {
  return String(payload?.error?.message ?? payload?.message ?? '').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
}

export function classifyGeminiTtsError(status: number, message = '') {
  if (status === 401) return { code: 'GEMINI-TTS-AUTH', retryable: false, fix: 'Check that the Google AI Studio API key is valid for this local user, then retry.' };
  if (status === 403) return { code: 'GEMINI-TTS-FORBIDDEN', retryable: false, fix: 'Enable Gemini API access for the key/project and confirm the selected TTS model is allowed.' };
  if (status === 429) return { code: 'GEMINI-TTS-RATE', retryable: true, fix: 'Wait for the rate/quota window, check project quota or billing, then retry only the failed question.' };
  if (status === 404 || /model.*(?:not found|unsupported)|unsupported.*model/i.test(message)) return { code: 'GEMINI-TTS-MODEL', retryable: false, fix: 'Choose a currently supported Gemini TTS model from Voice Studio.' };
  return { code: `GEMINI-TTS-HTTP-${status}`, retryable: status >= 500, fix: status >= 500 ? 'Gemini is temporarily unavailable. Retry the failed question.' : 'Check the Gemini error message, model, and project settings, then retry.' };
}

export function validateGeminiTtsRequest(text: string, voice: string, profile: VoiceProfile) {
  const apiKey = profile.geminiApiKey.trim();
  if (!apiKey) throw new AppError({ code: 'GEMINI-TTS-KEY-MISSING', agent: 'Gemini Voice Agent', stage: 'Gemini TTS', reason: 'Gemini API key is empty.', fix: 'Open Voice Studio → Gemini TTS, paste your Google AI Studio API key, then retry.', provider: 'Gemini TTS', retryable: false });
  if (!text.trim()) throw new AppError({ code: 'GEMINI-TTS-TEXT', agent: 'Gemini Voice Agent', stage: 'Gemini TTS', reason: 'The TTS line is empty.', fix: 'Enter Korean script text before generating voice.', provider: 'Gemini TTS', retryable: false });
  if (!GEMINI_TTS_MODELS.includes(profile.geminiModel)) throw new AppError({ code: 'GEMINI-TTS-MODEL', agent: 'Gemini Voice Agent', stage: 'Gemini TTS', reason: `Unsupported Gemini TTS model: ${profile.geminiModel}`, fix: 'Choose one of the Gemini TTS models shown in Voice Studio.', provider: 'Gemini TTS', retryable: false });
  if (!GEMINI_TTS_VOICES.includes(voice as any)) throw new AppError({ code: 'GEMINI-TTS-VOICE', agent: 'Gemini Voice Agent', stage: 'Gemini TTS', reason: `Unsupported Gemini voice: ${voice}`, fix: 'Choose one of the Gemini prebuilt voices shown in Voice Studio.', provider: 'Gemini TTS', retryable: false });
  return { apiKey, text: text.trim(), voice, model: profile.geminiModel };
}

export function buildGeminiTtsBody(text: string, voice: string, profile: VoiceProfile) {
  const style = profile.geminiStyle.trim() || 'Natural Korean EPS-TOPIK listening-test delivery. Clear pronunciation, neutral emotion, no extra words.';
  const prompt = `Read the Korean text exactly as written. Do not add, remove, translate, summarize, or explain anything. ${geminiPace(profile.rate)} Style: ${style}\n\nTEXT TO SPEAK:\n${text}`;
  return {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { languageCode: 'ko-KR', voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  };
}

function geminiPace(rate: number) {
  if (rate >= 7) return 'Speak noticeably faster than normal while staying clear.';
  if (rate >= 3) return 'Speak slightly faster than normal.';
  if (rate <= -7) return 'Speak noticeably slower than normal while staying natural.';
  if (rate <= -3) return 'Speak slightly slower than normal.';
  return 'Use a natural EPS-TOPIK exam pace.';
}

async function geminiToWav(text: string, output: string, voice: string, profile: VoiceProfile, workDir: string, index: number) {
  const validated = validateGeminiTtsRequest(text, voice, profile);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${profile.geminiModel}:generateContent`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': validated.apiKey },
      body: JSON.stringify(buildGeminiTtsBody(validated.text, validated.voice, profile)),
      signal: AbortSignal.timeout(180_000)
    });
  } catch (error) {
    throw new AppError({ code: 'GEMINI-TTS-NETWORK', agent: 'Gemini Voice Agent', stage: 'Gemini TTS', reason: 'Could not reach the Gemini TTS API.', fix: 'Check internet/VPN/firewall, then retry. The API key is never written to diagnostic logs.', detail: error instanceof Error ? error.message : String(error), cause: error, provider: 'Gemini TTS', retryable: true });
  }

  const rawBody = await response.text();
  let payload: any = null;
  try { payload = JSON.parse(rawBody); } catch {}
  if (!response.ok) {
    const msg = googleMessage(payload) || `Gemini returned HTTP ${response.status}.`;
    const classified = classifyGeminiTtsError(response.status, msg);
    throw new AppError({ code: classified.code, agent: 'Gemini Voice Agent', stage: 'Gemini TTS', reason: `Gemini TTS HTTP ${response.status}: ${msg}`, fix: classified.fix, detail: JSON.stringify(payload ?? { body: rawBody.slice(0, 2500) }, null, 2).slice(0, 3500), provider: 'Gemini TTS', httpStatus: response.status, retryable: classified.retryable });
  }

  const part = payload?.candidates?.[0]?.content?.parts?.find((x: any) => x?.inlineData?.data || x?.inline_data?.data);
  const inline = part?.inlineData ?? part?.inline_data;
  const data = inline?.data;
  if (!data) throw new AppError({ code: 'GEMINI-TTS-OUTPUT', agent: 'Gemini Voice Agent', stage: 'Gemini TTS', reason: 'Gemini responded successfully but no audio payload was returned.', fix: 'Retry once. If it repeats, try another Gemini TTS model/voice and inspect the technical detail.', detail: JSON.stringify(payload, null, 2).slice(0, 3500), provider: 'Gemini TTS', httpStatus: response.status, retryable: true });

  const bytes = Buffer.from(data, 'base64');
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF') {
    await fs.writeFile(output, bytes);
    return output;
  }

  const pcm = path.join(workDir, `_gemini-${index}.pcm`);
  await fs.writeFile(pcm, bytes);
  const ffmpeg = await ffmpegCommand();
  const converted = await run(ffmpeg, ['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, '-ar', '44100', '-ac', '1', output], { timeoutMs: 60_000, allowFailure: true });
  if (converted.code !== 0) throw new AppError({ code: 'GEMINI-TTS-PCM-CONVERT', agent: 'Gemini Voice Agent', stage: 'tts', reason: 'Gemini returned audio, but FFmpeg could not convert the PCM stream to WAV.', fix: 'Verify FFmpeg installation and retry.', detail: converted.stderr.slice(-3000) });
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
    const voice = voiceForSpeaker(lines[i].speaker, profile);
    if (profile.provider === 'gemini') await geminiToWav(lines[i].text, raw, voice, profile, dir, i + 1);
    else await sapiToWav(lines[i].text, raw, voice, profile.rate, profile.volume, dir, i + 1);
    await pitchProcess(raw, pitched, profile.pitch);
    const mp3 = path.join(dir, `line-${i + 1}.mp3`);
    const ffmpeg = await ffmpegCommand();
    const filters = profile.provider === 'gemini' && profile.volume !== 100 ? ['-af', `volume=${Math.max(0, profile.volume) / 100}`] : [];
    const encoded = await run(ffmpeg, ['-y', '-i', pitched, ...filters, '-ar', '44100', '-ac', '1', '-b:a', '128k', mp3], { timeoutMs: 60_000, allowFailure: true });
    if (encoded.code !== 0) throw new AppError({ code: 'TTS-MP3', agent: 'Voice Agent', stage: 'tts', reason: `Could not encode TTS line ${i + 1} to MP3.`, fix: 'Verify FFmpeg and retry.', detail: encoded.stderr.slice(-2500) });
    const encodedSize = (await fs.stat(mp3).catch(() => null))?.size ?? 0;
    if (encodedSize < 700) throw new AppError({ code: 'TTS-OUTPUT', agent: 'Voice Agent', stage: 'Voice Output', reason: `TTS line ${i + 1} did not contain usable audio.`, fix: profile.provider === 'windows' ? 'Install/select a Korean Windows speech voice or switch to Gemini TTS.' : 'Retry with another supported Gemini TTS voice/model.', detail: encoded.stderr.slice(-2500), provider: profile.provider === 'windows' ? 'Windows System.Speech' : 'Gemini TTS', tool: 'ffmpeg', retryable: profile.provider === 'gemini' });
    mp3s.push(mp3);
  }
  const output = path.join(jobDir, 'tts', `Q${String(question.number).padStart(2, '0')}.mp3`);
  try { await concatAudio(mp3s, output, dir, profile.pauseMs); }
  catch (error) { throw new AppError({ code: 'TTS-CONCAT', agent: 'Voice Agent', stage: 'Voice Assembly', reason: `Could not assemble Q${question.number} voice lines.`, fix: 'Inspect the failed voice line, correct the provider/voice, and retry this question.', detail: error instanceof Error ? error.message : String(error), provider: profile.provider === 'windows' ? 'Windows System.Speech' : 'Gemini TTS', question: question.number, retryable: true, cause: error }); }
  question.ttsAudioUrl = `tts/${path.basename(output)}`;
  return question;
}
