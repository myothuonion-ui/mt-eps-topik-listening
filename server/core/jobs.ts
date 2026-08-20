import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DiagnosticError, JobLog, JobStage, ListeningJob } from '../../src/shared.js';
import { DATA_ROOT, appendDiagnostic } from './errors.js';

const jobs = new Map<string, ListeningJob>();
const persistChains = new Map<string, Promise<void>>();

export function jobDir(id: string) {
  return path.join(DATA_ROOT, 'jobs', id);
}

async function persistSnapshot(job: ListeningJob) {
  const dir = jobDir(job.id);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'job.json');
  const tmp = path.join(dir, `job.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(job, null, 2), 'utf8');
    try {
      await fs.rename(tmp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (process.platform === 'win32' && ['EEXIST', 'EPERM', 'EACCES'].includes(code ?? '')) {
        await fs.rm(target, { force: true });
        await fs.rename(tmp, target);
      } else {
        throw error;
      }
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

function persist(job: ListeningJob) {
  const snapshot = structuredClone(job);
  const previous = persistChains.get(job.id) ?? Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(() => persistSnapshot(snapshot))
    .catch(error => {
      const code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
      console.error(`[PERSIST-${code}] ${job.id}:`, error);
    });
  persistChains.set(job.id, task);
  return task.finally(() => {
    if (persistChains.get(job.id) === task) persistChains.delete(job.id);
  });
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
    const job = JSON.parse(raw) as ListeningJob;
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

export function progress(id: string, input: { stage: JobStage; percent: number; agent: string; message: string; question?: number | null; level?: JobLog['level'] }) {
  const job = jobs.get(id);
  if (!job) throw new Error(`Job ${id} not found.`);
  job.status = input.stage === 'failed' ? 'failed' : input.stage === 'done' ? 'done' : input.stage === 'ready' ? 'ready' : 'running';
  job.stage = input.stage;
  job.percent = Math.max(job.percent, Math.max(0, Math.min(100, Math.round(input.percent))));
  job.currentAgent = input.agent;
  job.currentQuestion = input.question ?? null;
  job.updatedAt = new Date().toISOString();
  const log: JobLog = {
    id: randomUUID(),
    timestamp: job.updatedAt,
    level: input.level ?? 'info',
    agent: input.agent,
    stage: input.stage,
    percent: job.percent,
    question: input.question ?? null,
    message: input.message
  };
  job.logs.push(log);
  if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  void persist(job);
  return job;
}

export function warn(id: string, message: string) {
  const job = jobs.get(id);
  if (!job) return;
  if (!job.warnings.includes(message)) job.warnings.push(message);
  void persist(job);
}

export async function fail(id: string, diagnostic: DiagnosticError) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'failed';
  job.stage = 'failed';
  job.currentAgent = diagnostic.agent;
  job.error = diagnostic;
  job.updatedAt = new Date().toISOString();
  job.logs.push({ id: randomUUID(), timestamp: job.updatedAt, level: 'error', agent: diagnostic.agent, stage: 'failed', percent: job.percent, question: job.currentQuestion, message: `${diagnostic.code}: ${diagnostic.reason}` });
  await appendDiagnostic(diagnostic);
  await persist(job);
}
