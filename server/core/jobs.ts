import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DiagnosticError, JobLog, JobStage, ListeningJob, PipelineStageKey, StageState } from '../../src/shared.js';
import { DATA_ROOT, appendDiagnostic, sanitizeSecrets } from './errors.js';

const jobs = new Map<string, ListeningJob>();
const persistChains = new Map<string, Promise<void>>();
const STAGE_KEYS: PipelineStageKey[] = ['validate', 'download', 'normalize', 'transcript', 'split', 'clip', 'voice', 'export'];

export function initialStageStates(): Record<PipelineStageKey, StageState> {
  return Object.fromEntries(STAGE_KEYS.map(key => [key, 'waiting'])) as Record<PipelineStageKey, StageState>;
}

function initialQuestionStates() {
  return Object.fromEntries(Array.from({ length: 20 }, (_, index) => [String(index + 1), 'waiting'])) as Record<string, StageState>;
}

function stageKey(stage: JobStage): PipelineStageKey | null {
  if (stage === 'transcribe') return 'transcript';
  if (stage === 'tts') return 'voice';
  return STAGE_KEYS.includes(stage as PipelineStageKey) ? stage as PipelineStageKey : null;
}

function hydrateDefaults(job: ListeningJob) {
  job.stageStates = { ...initialStageStates(), ...(job.stageStates ?? {}) };
  job.questionStates = { ...initialQuestionStates(), ...(job.questionStates ?? {}) };
  job.lastSuccessfulStage ??= null;
  return job;
}

export function jobDir(id: string) {
  return path.join(DATA_ROOT, 'jobs', id);
}

async function durableWrite(file: string, body: string) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const backup = path.join(dir, `${path.basename(file)}.${process.pid}.${randomUUID()}.bak`);
  try {
    const handle = await fs.open(tmp, 'wx');
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes(code ?? '')) throw error;
      let movedExisting = false;
      try {
        await fs.rename(file, backup);
        movedExisting = true;
      } catch (moveError) {
        if ((moveError as NodeJS.ErrnoException)?.code !== 'ENOENT') throw moveError;
      }
      try {
        await fs.rename(tmp, file);
      } catch (replaceError) {
        if (movedExisting) await fs.rename(backup, file).catch(() => {});
        throw replaceError;
      }
      if (movedExisting) await fs.rm(backup, { force: true }).catch(() => {});
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
    await fs.rm(backup, { force: true }).catch(() => {});
  }
}

async function persistSnapshot(job: ListeningJob) {
  const dir = jobDir(job.id);
  const safeJob = JSON.parse(sanitizeSecrets(job)) as ListeningJob;
  await durableWrite(path.join(dir, 'job.json'), JSON.stringify(safeJob, null, 2));
  const jsonl = safeJob.logs.map(log => JSON.stringify(log)).join('\n');
  await durableWrite(path.join(dir, 'diagnostics', 'job-log.jsonl'), jsonl ? `${jsonl}\n` : '');
}

function persist(job: ListeningJob) {
  const snapshot = structuredClone(job);
  const previous = persistChains.get(job.id) ?? Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(() => persistSnapshot(snapshot))
    .catch(error => {
      const code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
      console.error(`[PERSIST-${code}] ${job.id}: ${sanitizeSecrets(error instanceof Error ? error.message : error)}`);
    });
  persistChains.set(job.id, task);
  void task.finally(() => {
    if (persistChains.get(job.id) === task) persistChains.delete(job.id);
  });
  return task;
}

export function createJob(sourceType: ListeningJob['sourceType'], sourceLabel: string) {
  const now = new Date().toISOString();
  const job: ListeningJob = {
    id: `LST-${Date.now()}-${randomUUID().slice(0, 6)}`,
    sourceType,
    sourceLabel,
    status: 'queued',
    stage: 'queued',
    percent: 0,
    currentAgent: 'Controller',
    currentQuestion: null,
    stageStates: initialStageStates(),
    questionStates: initialQuestionStates(),
    lastSuccessfulStage: null,
    createdAt: now,
    updatedAt: now,
    transcriptSource: null,
    transcript: [],
    questions: [],
    logs: [],
    error: null,
    sourceAudioUrl: null,
    exportUrl: null,
    warnings: []
  };
  jobs.set(job.id, job);
  void persist(job);
  return job;
}

export async function hydrateJob(id: string) {
  if (jobs.has(id)) return jobs.get(id)!;
  try {
    const raw = await fs.readFile(path.join(jobDir(id), 'job.json'), 'utf8');
    const job = hydrateDefaults(JSON.parse(raw) as ListeningJob);
    jobs.set(id, job);
    return job;
  } catch {
    return null;
  }
}

export function getJob(id: string) {
  return jobs.get(id) ?? null;
}

export function allJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateJob(id: string, patch: Partial<ListeningJob>) {
  const job = jobs.get(id);
  if (!job) throw new Error(`Job ${id} not found.`);
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  void persist(job);
  return job;
}

export function skipStages(id: string, stages: PipelineStageKey[]) {
  const job = jobs.get(id);
  if (!job) throw new Error(`Job ${id} not found.`);
  for (const key of stages) job.stageStates[key] = 'skipped';
  job.updatedAt = new Date().toISOString();
  void persist(job);
  return job;
}

export function progress(id: string, input: {
  stage: JobStage; percent: number; agent: string; message: string; question?: number | null;
  level?: JobLog['level']; state?: StageState;
}) {
  const job = jobs.get(id);
  if (!job) throw new Error(`Job ${id} not found.`);
  const previousKey = stageKey(job.stage);
  const nextKey = stageKey(input.stage);
  const nextQuestion = input.question ?? null;
  if (previousKey && previousKey !== nextKey && job.stageStates[previousKey] === 'running') {
    job.stageStates[previousKey] = 'success';
    job.lastSuccessfulStage = previousKey;
  }
  if (job.currentQuestion && nextQuestion !== job.currentQuestion && job.questionStates[String(job.currentQuestion)] === 'running') {
    job.questionStates[String(job.currentQuestion)] = 'success';
  }
  if (!nextKey && job.currentQuestion && job.questionStates[String(job.currentQuestion)] === 'running') {
    job.questionStates[String(job.currentQuestion)] = 'success';
  }
  if (nextKey) {
    const state = input.state ?? (input.level === 'success' ? 'success' : 'running');
    job.stageStates[nextKey] = state;
    if (state === 'success') job.lastSuccessfulStage = nextKey;
  }
  if (nextQuestion && (nextKey === 'clip' || nextKey === 'voice')) {
    job.questionStates[String(nextQuestion)] = input.state ?? (input.level === 'success' ? 'success' : 'running');
  }
  job.status = input.stage === 'failed' ? 'failed' : input.stage === 'done' ? 'done' : input.stage === 'ready' ? 'ready' : 'running';
  job.stage = input.stage;
  job.percent = Math.max(job.percent, Math.max(0, Math.min(100, Math.round(input.percent))));
  job.currentAgent = input.agent;
  job.currentQuestion = nextQuestion;
  if (job.status !== 'failed') job.error = null;
  job.updatedAt = new Date().toISOString();
  const log: JobLog = {
    id: randomUUID(),
    timestamp: job.updatedAt,
    level: input.level ?? 'info',
    agent: input.agent,
    stage: input.stage,
    percent: job.percent,
    question: nextQuestion,
    message: sanitizeSecrets(input.message)
  };
  job.logs.push(log);
  if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  void persist(job);
  return job;
}

export function warn(id: string, message: string) {
  const job = jobs.get(id);
  if (!job) return;
  const safe = sanitizeSecrets(message);
  if (!job.warnings.includes(safe)) job.warnings.push(safe);
  void persist(job);
}

export async function fail(id: string, diagnostic: DiagnosticError) {
  const job = jobs.get(id);
  if (!job) return;
  const activeKey = stageKey(job.stage);
  if (activeKey) job.stageStates[activeKey] = 'failed';
  if (job.currentQuestion) job.questionStates[String(job.currentQuestion)] = 'failed';
  job.status = 'failed';
  job.stage = 'failed';
  job.currentAgent = diagnostic.agent;
  job.error = JSON.parse(sanitizeSecrets(diagnostic)) as DiagnosticError;
  job.updatedAt = new Date().toISOString();
  job.logs.push({ id: randomUUID(), timestamp: job.updatedAt, level: 'error', agent: diagnostic.agent, stage: 'failed', percent: job.percent, question: diagnostic.question ?? job.currentQuestion, message: `${diagnostic.code}: ${sanitizeSecrets(diagnostic.reason)}` });
  await appendDiagnostic(job.error);
  await persist(job);
}

export async function waitForJobPersistence(id: string) {
  await (persistChains.get(id) ?? Promise.resolve());
}

export async function resetJobsForTests() {
  await Promise.all([...persistChains.values()]);
  jobs.clear();
  persistChains.clear();
}
