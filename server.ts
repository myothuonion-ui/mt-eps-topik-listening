import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ListeningQuestion, VoiceProfile } from './src/shared.js';
import { DATA_ROOT, diagnosticFrom } from './server/core/errors.js';
import { allJobs, createJob, fail, getJob, hydrateJob, jobDir, progress, updateJob } from './server/core/jobs.js';
import { runTextPipeline, runUploadPipeline, runYoutubePipeline } from './server/pipeline.js';
import { toolStatus } from './server/services/tools.js';
import { listSystemVoices, generateQuestionTts } from './server/services/tts.js';
import { recutQuestion } from './server/services/audio.js';
import { exportPackage } from './server/services/exporter.js';

const APP_VERSION = '1.0.0';
const PORT = Number(process.env.PORT ?? 8790);
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 700 * 1024 * 1024, files: 1 } });
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use('/media', express.static(path.join(DATA_ROOT, 'jobs')));

const voiceSchema = z.object({ narratorVoice: z.string().max(300).default(''), maleVoice: z.string().max(300).default(''), femaleVoice: z.string().max(300).default(''), rate: z.number().int().min(-10).max(10).default(0), pitch: z.number().min(-6).max(6).default(0), volume: z.number().int().min(0).max(100).default(100), pauseMs: z.number().int().min(0).max(3000).default(450) });
const youtubeSchema = z.object({ url: z.string().url() });
const textSchema = z.object({ text: z.string().min(1).max(500000) });

async function loadJob(id: string) { return getJob(id) ?? await hydrateJob(id); }
function mediaUrl(jobId: string, relative: string | null) { return relative ? `/media/${jobId}/${relative.replace(/\\/g, '/')}` : null; }
function publicJob<T extends { id: string; questions: ListeningQuestion[]; sourceAudioUrl: string | null; exportUrl: string | null }>(job: T) {
  return { ...job, sourceAudioUrl: mediaUrl(job.id, job.sourceAudioUrl), exportUrl: job.exportUrl, questions: job.questions.map(q => ({ ...q, sourceAudioUrl: mediaUrl(job.id, q.sourceAudioUrl), ttsAudioUrl: mediaUrl(job.id, q.ttsAudioUrl) })) };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'MT EPS TOPIK Listening Factory', version: APP_VERSION, port: PORT }));
app.get('/api/status', async (_req, res) => res.json({ ok: true, version: APP_VERSION, tools: await toolStatus(), voices: await listSystemVoices() }));
app.get('/api/jobs', (_req, res) => res.json({ ok: true, jobs: allJobs().map(publicJob) }));
app.get('/api/jobs/:id', async (req, res) => { const job = await loadJob(req.params.id); if (!job) return res.status(404).json({ ok: false, error: 'Job not found.' }); res.json({ ok: true, job: publicJob(job) }); });

app.post('/api/jobs/youtube', (req, res) => {
  try {
    const { url } = youtubeSchema.parse(req.body);
    const job = createJob('youtube', url);
    res.status(202).json({ ok: true, job: publicJob(job) });
    void runYoutubePipeline(job.id, url);
  } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post('/api/jobs/text', (req, res) => {
  try {
    const { text } = textSchema.parse(req.body);
    const job = createJob('text', 'Numbered Korean scripts');
    res.status(202).json({ ok: true, job: publicJob(job) });
    void runTextPipeline(job.id, text);
  } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post('/api/jobs/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('Choose one audio/video file.');
    const job = createJob('upload', req.file.originalname);
    const ext = path.extname(req.file.originalname).slice(0, 12) || '.bin';
    const file = path.join(jobDir(job.id), `upload${ext}`);
    await fs.mkdir(jobDir(job.id), { recursive: true });
    await fs.writeFile(file, req.file.buffer);
    res.status(202).json({ ok: true, job: publicJob(job) });
    void runUploadPipeline(job.id, file);
  } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

const questionPatch = z.object({ start: z.number().min(0).optional(), end: z.number().min(0).optional(), type: z.enum(['dialogue','monologue','question_only','spoken_choices','image_choice','unknown']).optional(), transcript: z.string().max(50000).optional(), script: z.string().max(50000).optional(), questionText: z.string().max(10000).optional(), choices: z.array(z.string().max(5000)).max(4).optional(), correctAnswerIndex: z.number().int().min(0).max(3).nullable().optional() });
app.patch('/api/jobs/:id/questions/:number', async (req, res) => {
  try {
    const job = await loadJob(req.params.id); if (!job) throw new Error('Job not found.');
    const number = Number(req.params.number); const q = job.questions.find(x => x.number === number); if (!q) throw new Error('Question not found.');
    const patch = questionPatch.parse(req.body);
    Object.assign(q, patch); if (q.end < q.start) q.end = q.start + 0.5;
    updateJob(job.id, { questions: job.questions });
    res.json({ ok: true, question: { ...q, sourceAudioUrl: mediaUrl(job.id, q.sourceAudioUrl), ttsAudioUrl: mediaUrl(job.id, q.ttsAudioUrl) }, job: publicJob(job) });
  } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post('/api/jobs/:id/questions/:number/cut', async (req, res) => {
  try {
    const job = await loadJob(req.params.id); if (!job) throw new Error('Job not found.');
    const q = job.questions.find(x => x.number === Number(req.params.number)); if (!q) throw new Error('Question not found.');
    progress(job.id, { stage: 'clip', percent: Math.max(job.percent, 80), agent: 'Audio Split Agent', question: q.number, message: `Re-cutting Q${q.number} with edited timestamps.` });
    await recutQuestion(path.join(jobDir(job.id), 'source.wav'), q, jobDir(job.id));
    updateJob(job.id, { questions: job.questions }); progress(job.id, { stage: 'ready', percent: 82, agent: 'Audio Split Agent', question: q.number, message: `Q${q.number} source clip updated.`, level: 'success' });
    res.json({ ok: true, job: publicJob(job) });
  } catch (error) { const job = await loadJob(req.params.id); if (job) await fail(job.id, diagnosticFrom(error, { code: 'RECUT', agent: 'Audio Split Agent', stage: 'clip', fix: 'Check the edited start/end timestamps and source.wav, then retry.' })); res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post('/api/jobs/:id/questions/:number/tts', async (req, res) => {
  try {
    const profile = voiceSchema.parse(req.body) as VoiceProfile;
    const job = await loadJob(req.params.id); if (!job) throw new Error('Job not found.');
    const q = job.questions.find(x => x.number === Number(req.params.number)); if (!q) throw new Error('Question not found.');
    progress(job.id, { stage: 'tts', percent: Math.max(84, job.percent), agent: 'Voice Agent', question: q.number, message: `Generating customized voice for Q${q.number}.` });
    await generateQuestionTts(q, profile, jobDir(job.id)); updateJob(job.id, { questions: job.questions });
    progress(job.id, { stage: 'ready', percent: 90, agent: 'Voice Agent', question: q.number, message: `Q${q.number} TTS audio ready.`, level: 'success' });
    res.json({ ok: true, job: publicJob(job) });
  } catch (error) { const job = await loadJob(req.params.id); if (job) await fail(job.id, diagnosticFrom(error, { code: 'TTS', agent: 'Voice Agent', stage: 'tts', fix: 'Choose an installed voice and verify FFmpeg/PowerShell, then retry.' })); res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post('/api/jobs/:id/tts-all', async (req, res) => {
  try {
    const profile = voiceSchema.parse(req.body) as VoiceProfile;
    const job = await loadJob(req.params.id); if (!job) throw new Error('Job not found.');
    res.status(202).json({ ok: true, job: publicJob(job) });
    void (async () => {
      try {
        for (let i = 0; i < job.questions.length; i += 1) {
          const q = job.questions[i]; if (!q.script.trim()) continue;
          progress(job.id, { stage: 'tts', percent: 82 + Math.round((i + 1) / Math.max(1, job.questions.length) * 13), agent: 'Voice Agent', question: q.number, message: `Generating customized voice Q${q.number}/${job.questions.length}.` });
          await generateQuestionTts(q, profile, jobDir(job.id));
        }
        updateJob(job.id, { questions: job.questions }); progress(job.id, { stage: 'ready', percent: 95, agent: 'Voice Agent', message: 'Voice generation completed. You can export the final package.', level: 'success' });
      } catch (error) { await fail(job.id, diagnosticFrom(error, { code: 'TTS-ALL', agent: 'Voice Agent', stage: 'tts', fix: 'Open the exact error, correct the voice/tool setting, then retry Generate All.' })); }
    })();
  } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post('/api/custom-voice', async (req, res) => {
  try {
    const input = z.object({ text: z.string().min(1).max(100000), profile: voiceSchema }).parse(req.body);
    const job = createJob('text', 'Custom text voice');
    const q: ListeningQuestion = { number: 1, start: 0, end: 0, confidence: 1, boundarySource: 'text', type: 'monologue', transcript: input.text, script: input.text, questionText: '', choices: [], correctAnswerIndex: null, sourceAudioUrl: null, ttsAudioUrl: null, flags: [] };
    updateJob(job.id, { questions: [q], transcriptSource: 'text', transcript: [{ start: 0, end: 1, text: input.text, source: 'text' }] });
    res.status(202).json({ ok: true, job: publicJob(job) });
    void (async () => { try { progress(job.id, { stage: 'tts', percent: 30, agent: 'Voice Agent', question: 1, message: 'Generating custom Korean voice.' }); await generateQuestionTts(q, input.profile as VoiceProfile, jobDir(job.id)); updateJob(job.id, { questions: [q] }); progress(job.id, { stage: 'done', percent: 100, agent: 'Voice Agent', question: 1, message: 'Custom voice is ready to play/download.', level: 'success' }); } catch (error) { await fail(job.id, diagnosticFrom(error, { code: 'CUSTOM-TTS', agent: 'Voice Agent', stage: 'tts', fix: 'Choose a working installed voice and retry.' })); } })();
  } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post('/api/jobs/:id/export', async (req, res) => {
  try {
    const job = await loadJob(req.params.id); if (!job) throw new Error('Job not found.');
    progress(job.id, { stage: 'export', percent: 96, agent: 'Export Agent', message: 'Building MP3 + TXT + JSON + PDF + ZIP package.' });
    const zip = await exportPackage(job, jobDir(job.id)); const relative = path.basename(zip); updateJob(job.id, { exportUrl: `/api/jobs/${job.id}/download` });
    progress(job.id, { stage: 'done', percent: 100, agent: 'Export Agent', message: `Final package ready: ${relative}`, level: 'success' });
    res.json({ ok: true, job: publicJob(job), downloadUrl: `/api/jobs/${job.id}/download` });
  } catch (error) { const job = await loadJob(req.params.id); if (job) await fail(job.id, diagnosticFrom(error, { code: 'EXPORT', agent: 'Export Agent', stage: 'export', fix: 'Make sure at least one source/TTS question audio exists and FFmpeg is ready, then retry.' })); res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.get('/api/jobs/:id/download', async (req, res) => {
  const job = await loadJob(req.params.id); if (!job) return res.status(404).send('Job not found.');
  const dir = jobDir(job.id); const names = await fs.readdir(dir).catch(() => [] as string[]); const zip = names.find(x => /^EPS_Listening_.*\.zip$/i.test(x)); if (!zip) return res.status(404).send('Export package not found.');
  res.download(path.join(dir, zip), zip);
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(currentDir, 'client');
app.use(express.static(clientDir));
app.get('*', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));

app.listen(PORT, '127.0.0.1', () => console.log(`[READY] MT EPS Listening Factory v${APP_VERSION} http://127.0.0.1:${PORT}`));
