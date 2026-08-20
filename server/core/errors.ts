import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DiagnosticError } from '../../src/shared.js';

export const DATA_ROOT = path.resolve(process.env.LISTENING_DATA_DIR ?? path.join(process.cwd(), 'data'));

export class AppError extends Error {
  code: string;
  agent: string;
  stage: string;
  fix: string;
  detail?: string;

  constructor(input: { code: string; agent: string; stage: string; reason: string; fix: string; detail?: string; cause?: unknown }) {
    super(input.reason, { cause: input.cause });
    this.name = 'AppError';
    this.code = input.code;
    this.agent = input.agent;
    this.stage = input.stage;
    this.fix = input.fix;
    this.detail = input.detail;
  }
}

function stackLocation(stack?: string) {
  if (!stack) return { file: null, line: null, column: null };
  const lines = stack.split('\n');
  for (const row of lines) {
    const m = row.match(/(?:file:\/\/\/)?([^()\s]+\.(?:ts|js|mjs)):(\d+):(\d+)/i);
    if (!m) continue;
    return { file: m[1].replace(/\\/g, '/'), line: Number(m[2]), column: Number(m[3]) };
  }
  return { file: null, line: null, column: null };
}

export function diagnosticFrom(error: unknown, fallback: { code: string; agent: string; stage: string; fix: string }): DiagnosticError {
  const app = error instanceof AppError ? error : null;
  const base = error instanceof Error ? error : new Error(String(error));
  const loc = stackLocation(base.stack);
  return {
    id: `ERR-${Date.now()}-${randomUUID().slice(0, 6)}`,
    timestamp: new Date().toISOString(),
    code: app?.code ?? fallback.code,
    agent: app?.agent ?? fallback.agent,
    stage: app?.stage ?? fallback.stage,
    file: loc.file,
    line: loc.line,
    column: loc.column,
    reason: app?.message ?? base.message,
    fix: app?.fix ?? fallback.fix,
    detail: app?.detail ?? (base.stack ? base.stack.slice(0, 3500) : undefined)
  };
}

export async function appendDiagnostic(diagnostic: DiagnosticError) {
  const dir = path.join(DATA_ROOT, 'diagnostics');
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, 'errors.jsonl'), `${JSON.stringify(diagnostic)}\n`, 'utf8');
}
