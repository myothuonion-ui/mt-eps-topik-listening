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
  provider?: string;
  httpStatus?: number | null;
  tool?: string;
  exitCode?: number | null;
  question?: number | null;
  retryable?: boolean;
  source?: string;

  constructor(input: {
    code: string; agent: string; stage: string; reason: string; fix: string; detail?: string; cause?: unknown;
    provider?: string; httpStatus?: number | null; tool?: string; exitCode?: number | null;
    question?: number | null; retryable?: boolean; source?: string;
  }) {
    super(input.reason, { cause: input.cause });
    this.name = 'AppError';
    this.code = input.code;
    this.agent = input.agent;
    this.stage = input.stage;
    this.fix = input.fix;
    this.detail = input.detail;
    this.provider = input.provider;
    this.httpStatus = input.httpStatus;
    this.tool = input.tool;
    this.exitCode = input.exitCode;
    this.question = input.question;
    this.retryable = input.retryable;
    this.source = input.source;
  }
}

export function sanitizeSecrets(value: unknown) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  text = text
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/([?&](?:key|api_key|token|pot|po_token|visitor_data)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(youtube:po_token=)[^\s;"']+/gi, '$1[REDACTED]')
    .replace(/("(?:geminiApiKey|nvidiaApiKey|cloudflareApiToken|apiKey|apiToken|cookie|cookies|authorization|x-goog-api-key)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/((?:authorization|cookie|x-goog-api-key)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');
  return text;
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
  const rawDetail = app?.detail ?? base.stack?.slice(0, 3500);
  return {
    id: `ERR-${Date.now()}-${randomUUID().slice(0, 6)}`,
    timestamp: new Date().toISOString(),
    code: app?.code ?? fallback.code,
    agent: app?.agent ?? fallback.agent,
    stage: app?.stage ?? fallback.stage,
    file: loc.file,
    line: loc.line,
    column: loc.column,
    reason: sanitizeSecrets(app?.message ?? base.message),
    fix: sanitizeSecrets(app?.fix ?? fallback.fix),
    detail: rawDetail ? sanitizeSecrets(rawDetail) : undefined,
    provider: app?.provider,
    httpStatus: app?.httpStatus,
    tool: app?.tool,
    exitCode: app?.exitCode,
    question: app?.question,
    retryable: app?.retryable,
    source: app?.source ? sanitizeSecrets(app.source) : undefined
  };
}

export async function appendDiagnostic(diagnostic: DiagnosticError) {
  const dir = path.join(DATA_ROOT, 'diagnostics');
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, 'errors.jsonl'), `${sanitizeSecrets(diagnostic)}\n`, 'utf8');
}
