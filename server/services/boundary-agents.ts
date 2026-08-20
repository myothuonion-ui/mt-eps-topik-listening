import type { BoundaryAutomation, ListeningQuestion, TranscriptSegment } from '../../src/shared.js';
import type { BoundaryProposal } from './splitter.js';

export type BoundaryAgentProvider = 'gemini' | 'nvidia' | 'cloudflare';
export type BoundaryAgentResult = {
  provider: BoundaryAgentProvider | 'deterministic';
  proposals: BoundaryProposal[] | null;
  attempts: string[];
};

function responseJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  try { return JSON.parse(candidate); }
  catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(candidate.slice(first, last + 1));
    throw new Error('Agent response did not contain a JSON object.');
  }
}

export function parseBoundaryAgentResponse(text: string, expectedSourceNumbers: number[], duration: number): BoundaryProposal[] {
  const parsed = responseJson(text);
  const rows = Array.isArray(parsed?.boundaries) ? parsed.boundaries : [];
  if (rows.length !== expectedSourceNumbers.length) throw new Error(`Agent returned ${rows.length}/${expectedSourceNumbers.length} boundaries.`);
  const proposals: BoundaryProposal[] = rows.map((row: any) => ({
    sourceNumber: Number(row?.sourceNumber),
    start: Number(row?.start),
    confidence: Number(row?.confidence),
    reason: typeof row?.reason === 'string' ? row.reason.slice(0, 180) : ''
  }));
  const numbers = proposals.map((row: BoundaryProposal) => row.sourceNumber);
  if (new Set(numbers).size !== expectedSourceNumbers.length || numbers.some((number, index) => number !== expectedSourceNumbers[index])) {
    throw new Error('Agent source question numbers are missing, duplicated, or out of order.');
  }
  for (let index = 0; index < proposals.length; index += 1) {
    const row = proposals[index];
    if (!Number.isFinite(row.start) || row.start < 0 || row.start >= duration) throw new Error(`Agent returned an invalid start for source Q${row.sourceNumber}.`);
    if (!Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1) throw new Error(`Agent returned invalid confidence for source Q${row.sourceNumber}.`);
    if (index > 0 && row.start <= proposals[index - 1].start + 0.25) throw new Error('Agent boundaries are not strictly increasing.');
  }
  return proposals;
}

function boundaryPrompt(segments: TranscriptSegment[], base: ListeningQuestion[], duration: number) {
  const transcript = segments.map(segment => `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}`).join('\n').slice(0, 58_000);
  const map = base.map(question => ({
    outputQuestion: question.number,
    sourceNumber: question.sourceNumber,
    start: Number(question.start.toFixed(2)),
    end: Number(question.end.toFixed(2)),
    confidence: Number(question.confidence.toFixed(2)),
    evidence: question.boundarySource
  }));
  return `You are the boundary verification agent for a Korean EPS-TOPIK listening recording.
Return JSON only: {"boundaries":[{"sourceNumber":21,"start":12.34,"confidence":0.91,"reason":"short evidence"}]}.
Rules:
- Return exactly ${base.length} rows, in source-number order ${base[0].sourceNumber} through ${base.at(-1)!.sourceNumber}.
- A boundary start is the beginning of that complete source question, after any section-wide instructions.
- Phrases like "21번부터 24번까지" are section headers. They are not individual question starts.
- Spoken answer choices "1번", "2번", "3번", "4번" are never question-number anchors.
- Keep explicit "NN번 문제입니다" anchors unless timestamp evidence clearly places the spoken marker a fraction earlier.
- Use the deterministic map as the prior. Repair only boundaries supported by timestamped transcript evidence.
- Starts must be strictly increasing, within 0-${duration.toFixed(2)} seconds. Confidence must be 0-1.

DETERMINISTIC MAP:
${JSON.stringify(map)}

TIMESTAMPED TRANSCRIPT:
${transcript}`;
}

async function requestJson(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
  const raw = await response.text();
  let payload: any = null;
  try { payload = JSON.parse(raw); } catch {}
  if (!response.ok) throw new Error(`HTTP ${response.status}${payload?.error?.message ? `: ${String(payload.error.message).slice(0, 240)}` : ''}`);
  return payload;
}

async function callGemini(prompt: string, settings: BoundaryAutomation) {
  const model = settings.geminiModel.trim() || 'gemini-2.5-flash';
  const payload = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.geminiApiKey.trim() },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' }
    })
  });
  return String(payload?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? '').join('') ?? '');
}

async function callNvidia(prompt: string, settings: BoundaryAutomation) {
  const payload = await requestJson('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.nvidiaApiKey.trim()}` },
    body: JSON.stringify({
      model: settings.nvidiaModel.trim() || 'meta/llama-3.1-8b-instruct',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 4096,
      stream: false
    })
  });
  return String(payload?.choices?.[0]?.message?.content ?? '');
}

async function callCloudflare(prompt: string, settings: BoundaryAutomation) {
  const account = encodeURIComponent(settings.cloudflareAccountId.trim());
  const model = (settings.cloudflareModel.trim() || '@cf/meta/llama-3.1-8b-instruct').replace(/^\/+/, '');
  const payload = await requestJson(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.cloudflareApiToken.trim()}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 4096 })
  });
  if (payload?.success === false) throw new Error(`Cloudflare rejected the request: ${JSON.stringify(payload?.errors ?? []).slice(0, 300)}`);
  return String(payload?.result?.response ?? payload?.result?.text ?? '');
}

export async function runBoundaryAgentFallback(segments: TranscriptSegment[], base: ListeningQuestion[], duration: number, settings: BoundaryAutomation): Promise<BoundaryAgentResult> {
  if (settings.mode === 'manual') return { provider: 'deterministic', proposals: null, attempts: [] };
  const prompt = boundaryPrompt(segments, base, duration);
  const expected = base.map(question => question.sourceNumber);
  const providers: { name: BoundaryAgentProvider; ready: boolean; call: () => Promise<string> }[] = [
    { name: 'gemini', ready: Boolean(settings.geminiApiKey.trim()), call: () => callGemini(prompt, settings) },
    { name: 'nvidia', ready: Boolean(settings.nvidiaApiKey.trim()), call: () => callNvidia(prompt, settings) },
    { name: 'cloudflare', ready: Boolean(settings.cloudflareApiToken.trim() && settings.cloudflareAccountId.trim()), call: () => callCloudflare(prompt, settings) }
  ];
  const attempts: string[] = [];
  for (const provider of providers) {
    if (!provider.ready) continue;
    try {
      const text = await provider.call();
      const proposals = parseBoundaryAgentResponse(text, expected, duration);
      return { provider: provider.name, proposals, attempts };
    } catch (error) {
      attempts.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 360));
    }
  }
  return { provider: 'deterministic', proposals: null, attempts };
}
