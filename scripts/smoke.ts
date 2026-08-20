import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testData = await fs.mkdtemp(path.join(os.tmpdir(), 'mt-eps-listening-tests-'));
process.env.LISTENING_DATA_DIR = testData;

const { markerCount, splitIntoTwenty, detectType } = await import('../server/services/splitter.js');
const { classifyYoutubeFailure, executeYoutubeAudioAttempts, youtubeAccessArgs, youtubeAudioAttempts } = await import('../server/services/youtube.js');
const { sanitizeSecrets } = await import('../server/core/errors.js');
const { createJob, fail, getJob, progress, resetJobsForTests, waitForJobPersistence } = await import('../server/core/jobs.js');
const { buildGeminiTtsBody, classifyGeminiTtsError, validateGeminiTtsRequest } = await import('../server/services/tts.js');
const { resolveQuestionAudio } = await import('../server/services/exporter.js');

async function test(name: string, body: () => void | Promise<void>) {
  await body();
  console.log(`PASS ${name}`);
}

await test('Q1-Q20 splitter uses explicit Korean number markers', () => {
  const segments = Array.from({ length: 20 }, (_, index) => ({ start: index * 10, end: index * 10 + 8, text: `${index + 1}번 다음을 듣고 알맞은 것을 고르십시오. 테스트 대화입니다.`, source: 'caption' as const }));
  assert.equal(markerCount(segments), 20);
  const questions = splitIntoTwenty(segments, 200);
  assert.equal(questions.length, 20);
  assert.equal(questions.every(question => question.boundarySource === 'explicit-number'), true);
  assert.deepEqual(questions.map(question => question.number), Array.from({ length: 20 }, (_, index) => index + 1));
});

await test('splitter recognizes layered types and silence boundaries', () => {
  assert.equal(detectType('안내 방송입니다. 작업장 안전 수칙을 알려 드립니다.'), 'announcement');
  assert.equal(detectType('전화번호는 몇 번입니까?'), 'number');
  const segments = Array.from({ length: 20 }, (_, index) => ({ start: index * 12, end: index * 12 + 8, text: index === 0 ? '다음을 듣고 알맞은 것을 고르십시오.' : '테스트 문장입니다.', source: 'whisper' as const }));
  const questions = splitIntoTwenty(segments, 240);
  assert.equal(questions.length, 20);
  assert.equal(questions.some(question => question.boundarySource === 'silence-gap' || question.boundarySource === 'spoken-cue'), true);
});

await test('YouTube browser cookies are strictly opt-in', () => {
  assert.deepEqual(youtubeAccessArgs({ mode: 'auto', browser: 'chrome' }), []);
  assert.deepEqual(youtubeAccessArgs({ mode: 'browser', browser: 'edge' }), ['--cookies-from-browser', 'edge']);
});

await test('YouTube 403 and provider failures are classified exactly', () => {
  const pot = classifyYoutubeFailure('ERROR: unable to download video data: HTTP Error 403: Forbidden. No gvs PO Token was provided', { phase: 'audio', providerReady: false, exitCode: 1 });
  assert.equal(pot.code, 'YT-403-POT');
  assert.equal(pot.httpStatus, 403);
  const missing = classifyYoutubeFailure('No GVS PO Token provider available for web client', { phase: 'audio', providerReady: false, exitCode: 1 });
  assert.equal(missing.code, 'YT-PROVIDER-MISSING');
});

await test('YouTube fallback sequence stops on a successful supported attempt', async () => {
  const attempts = youtubeAudioAttempts(true);
  assert.deepEqual(attempts.map(attempt => attempt.name), ['default-auto', 'mweb-po-token-provider', 'web-safari-hls']);
  const called: string[] = [];
  const result = await executeYoutubeAudioAttempts(attempts, async attempt => {
    called.push(attempt.name);
    return attempt.name === 'mweb-po-token-provider'
      ? { code: 0, stdout: '', stderr: '', file: 'youtube-source.webm' }
      : { code: 1, stdout: '', stderr: 'HTTP Error 403: Forbidden', file: null };
  });
  assert.equal(result.success, true);
  assert.deepEqual(called, ['default-auto', 'mweb-po-token-provider']);
});

await test('secret sanitizer removes API keys, tokens, cookies, and auth headers', () => {
  const secret = 'test-gemini-api-key-not-a-secret';
  const sanitized = sanitizeSecrets(`{"geminiApiKey":"${secret}"}\nAuthorization: Bearer abc\nCookie: SID=hidden\n?po_token=token123`);
  assert.equal(sanitized.includes(secret), false);
  assert.equal(sanitized.includes('SID=hidden'), false);
  assert.equal(sanitized.includes('token123'), false);
});

await test('concurrent per-job persistence stays valid and serialized', async () => {
  const job = createJob('text', 'persistence regression');
  await Promise.all(Array.from({ length: 140 }, async (_, index) => {
    progress(job.id, { stage: 'download', percent: index % 100, agent: 'Persistence Test', message: `event ${index}` });
  }));
  await waitForJobPersistence(job.id);
  const raw = await fs.readFile(path.join(testData, 'jobs', job.id, 'job.json'), 'utf8');
  const persisted = JSON.parse(raw);
  assert.equal(persisted.id, job.id);
  assert.equal(persisted.logs.length, 140);
  const jobFiles = await fs.readdir(path.join(testData, 'jobs', job.id), { recursive: true });
  assert.equal(jobFiles.some(name => String(name).endsWith('.tmp')), false);
  const diagnosticLines = (await fs.readFile(path.join(testData, 'jobs', job.id, 'diagnostics', 'job-log.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(diagnosticLines.length, 140);
});

await test('failed progress never renders Download as successful', async () => {
  const job = createJob('youtube', 'failure state');
  progress(job.id, { stage: 'validate', percent: 3, agent: 'Controller', message: 'valid' });
  progress(job.id, { stage: 'download', percent: 14, agent: 'Downloader Agent', message: 'download' });
  await fail(job.id, { id: 'test', timestamp: new Date().toISOString(), code: 'YT-403-POT', agent: 'Downloader Agent', stage: 'YouTube Audio Download', file: null, line: null, column: null, reason: '403', fix: 'provider', provider: 'yt-dlp', httpStatus: 403, retryable: true });
  const failed = getJob(job.id)!;
  assert.equal(failed.stageStates.validate, 'success');
  assert.equal(failed.stageStates.download, 'failed');
  assert.equal(failed.stageStates.normalize, 'waiting');
});

const geminiProfile = {
  provider: 'gemini', narratorVoice: '', maleVoice: '', femaleVoice: '', rate: 0, pitch: 0, volume: 100, pauseMs: 450,
  geminiApiKey: 'test-key-not-a-real-secret', geminiModel: 'gemini-2.5-flash-preview-tts', geminiNarratorVoice: 'Kore', geminiMaleVoice: 'Charon', geminiFemaleVoice: 'Aoede', geminiStyle: 'Clear Korean.'
} as const;

await test('Gemini TTS request validation and body keep key out of payload', () => {
  const valid = validateGeminiTtsRequest('안녕하세요.', 'Kore', geminiProfile);
  assert.equal(valid.model, 'gemini-2.5-flash-preview-tts');
  const body = buildGeminiTtsBody(valid.text, valid.voice, geminiProfile);
  assert.equal(JSON.stringify(body).includes(geminiProfile.geminiApiKey), false);
  assert.equal((body.generationConfig.responseModalities as string[])[0], 'AUDIO');
});

await test('Gemini errors have stable exact classifiers', () => {
  assert.equal(classifyGeminiTtsError(401).code, 'GEMINI-TTS-AUTH');
  assert.equal(classifyGeminiTtsError(403).code, 'GEMINI-TTS-FORBIDDEN');
  assert.equal(classifyGeminiTtsError(429).code, 'GEMINI-TTS-RATE');
  assert.equal(classifyGeminiTtsError(404).code, 'GEMINI-TTS-MODEL');
});

await test('export audio selection prefers TTS and falls back to source clips', async () => {
  const dir = path.join(testData, 'export-fallback');
  await fs.mkdir(path.join(dir, 'clips'), { recursive: true });
  await fs.mkdir(path.join(dir, 'tts'), { recursive: true });
  await fs.writeFile(path.join(dir, 'clips', 'Q01-source.mp3'), 'source');
  assert.equal((await resolveQuestionAudio(dir, 1))?.kind, 'source');
  await fs.writeFile(path.join(dir, 'tts', 'Q01.mp3'), 'tts');
  assert.equal((await resolveQuestionAudio(dir, 1))?.kind, 'tts');
});

await resetJobsForTests();
await fs.rm(testData, { recursive: true, force: true });
console.log('Smoke PASS: all Listening Factory regression checks passed.');
