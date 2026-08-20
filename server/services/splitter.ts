import type { ListeningQuestion, QuestionAudioType, TranscriptSegment } from '../../src/shared.js';

export type BoundaryEvidence = { time: number; confidence?: number; source?: 'silence-gap' };
export type BoundaryProposal = { sourceNumber: number; start: number; confidence: number; reason?: string };
export type DetectedQuestionRange = { start: number; end: number };

type BoundaryStart = {
  time: number;
  source: ListeningQuestion['boundarySource'];
  confidence: number;
  sourceNumber: number;
};

type Section = {
  startNumber: number;
  endNumber: number;
  headerStart: number;
  questionStart: number;
  sectionEnd: number;
};

function compact(text: string) {
  return text.replace(/&gt;/g, '>').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function individualMarker(text: string) {
  const normalized = compact(text);
  if (/\d{1,2}\s*번부터|\d{1,2}\s*번까지/.test(normalized)) return null;
  const strong = normalized.match(/(?:^|[>\s])(?:Q\s*)?(\d{1,2})\s*번\s*(?:문제(?:입니다|예요|이다)?|다음을|다음\s|들으)/i);
  if (!strong) return null;
  const number = Number(strong[1]);
  return number >= 1 && number <= 60 ? number : null;
}

function rangeHeaders(segments: TranscriptSegment[]) {
  const found: Omit<Section, 'sectionEnd'>[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (!/다음/.test(segments[index].text)) continue;
    const nearby = segments.slice(index, index + 12).filter(segment => segment.start <= segments[index].start + 18);
    const combined = nearby.map(segment => compact(segment.text)).join(' ');
    const match = combined.match(/다음(?:은|에는)?\s*(\d{1,2})\s*번부터\s*(\d{1,2})\s*번까지/);
    if (!match) continue;
    const startNumber = Number(match[1]);
    const endNumber = Number(match[2]);
    if (startNumber < 1 || endNumber < startNumber || endNumber - startNumber > 19) continue;
    if (found.some(header => header.startNumber === startNumber && Math.abs(header.headerStart - segments[index].start) < 20)) continue;
    let instructionEnd = segments[index].end;
    for (const candidate of nearby) {
      if (/고르십시오|선택하십시오|답하십시오/.test(candidate.text)) {
        instructionEnd = candidate.end;
        break;
      }
      if (/문제입니다|번까지/.test(candidate.text)) instructionEnd = Math.max(instructionEnd, candidate.end);
    }
    const firstContent = segments.find(segment => segment.start >= instructionEnd - 0.01
      && segment.start <= instructionEnd + 15
      && !/^(?:문제입니다|다음(?:은|을|의|\s)|.*번(?:부터|까지))/.test(compact(segment.text)));
    found.push({
      startNumber,
      endNumber,
      headerStart: segments[index].start,
      questionStart: Math.max(instructionEnd, firstContent?.start ?? instructionEnd)
    });
  }
  return found.sort((a, b) => a.headerStart - b.headerStart);
}

export function detectQuestionRange(segments: TranscriptSegment[]): DetectedQuestionRange {
  const headers = rangeHeaders(segments);
  if (headers.length) {
    const start = headers[0].startNumber;
    const contiguousEnd = headers.reduce((end, header) => header.startNumber <= end + 1 ? Math.max(end, header.endNumber) : end, headers[0].endNumber);
    if (contiguousEnd - start + 1 >= 20) return { start, end: start + 19 };
  }
  const explicit = segments.map(segment => individualMarker(segment.text)).filter((number): number is number => number !== null);
  const unique = [...new Set(explicit)].sort((a, b) => a - b);
  if (unique.length) {
    for (const start of unique) {
      if (unique.filter(number => number >= start && number <= start + 19).length >= 10) return { start, end: start + 19 };
    }
  }
  return { start: 1, end: 20 };
}

export function detectType(text: string): QuestionAudioType {
  const t = text.replace(/\s+/g, ' ');
  if (/그림|사진|보기의 그림|알맞은 그림/.test(t)) return 'image_choice';
  const choiceHits = (t.match(/(?:^|\s)(?:1|2|3|4|①|②|③|④)\s*(?:번|[.)])/g) ?? []).length;
  if (choiceHits >= 3) return 'spoken_choices';
  if (/전화번호|휴대폰|금액|가격|몇\s*(?:시|분|명|개|원)|숫자/.test(t)) return 'number';
  if (/안내\s*(?:방송|말씀)|알려\s*드립니다|공지|방송입니다/.test(t)) return 'announcement';
  if (/(남자|남:|여자|여:)/.test(t)) return 'dialogue';
  if (/[-–—]\s*[^-–—]+[-–—]/.test(t) || (/(?:습니까|어요|예요|네요)[.?!]?\s+/.test(t) && t.length >= 45)) return 'conversation';
  if (t.length < 80 && /무엇|어디|언제|누구|왜|어떻게|고르|맞는|알맞/.test(t)) return 'question_only';
  if (t.length >= 80) return 'monologue';
  return 'unknown';
}

function parseChoices(text: string) {
  const marks = [...text.matchAll(/(?:^|\s)([1-4①②③④])\s*(?:번|[.)])\s*/g)];
  if (marks.length < 4) return [] as string[];
  const choices: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const start = marks[index].index! + marks[index][0].length;
    const end = index < 3 ? marks[index + 1].index! : text.length;
    choices.push(text.slice(start, end).trim());
  }
  return choices.every(Boolean) ? choices : [];
}

function questionTextFrom(text: string) {
  const first = text.split(/(?<=[.?!다요까])\s+/).find(row => /무엇|어디|언제|누구|왜|어떻게|고르|맞는|알맞/.test(row));
  return first?.trim() ?? '';
}

function textInRange(segments: TranscriptSegment[], start: number, end: number) {
  return segments.filter(segment => segment.end > start && segment.start < end).map(segment => segment.text).join(' ').replace(/\s+/g, ' ').trim();
}

function explicitAnchors(segments: TranscriptSegment[], range: DetectedQuestionRange) {
  const map = new Map<number, number>();
  for (const segment of segments) {
    const number = individualMarker(segment.text);
    if (number !== null && number >= range.start && number <= range.end && !map.has(number)) map.set(number, segment.start);
  }
  return map;
}

function captionGapEvidence(segments: TranscriptSegment[], duration: number): BoundaryEvidence[] {
  const average = duration / 20;
  return segments.slice(1).flatMap((segment, index) => {
    const previous = segments[index];
    const gap = segment.start - previous.end;
    return gap >= Math.max(0.75, average * 0.045) ? [{ time: segment.start, confidence: Math.min(0.72, 0.52 + gap / Math.max(8, average) * 0.18), source: 'silence-gap' as const }] : [];
  });
}

function buildSections(segments: TranscriptSegment[], duration: number, range: DetectedQuestionRange) {
  const headers = rangeHeaders(segments)
    .filter(header => header.endNumber >= range.start && header.startNumber <= range.end)
    .map((header, index, all) => ({ ...header, sectionEnd: all[index + 1]?.headerStart ?? duration }));
  const covered = new Set(headers.flatMap(header => Array.from({ length: header.endNumber - header.startNumber + 1 }, (_, index) => header.startNumber + index)));
  if (Array.from({ length: 20 }, (_, index) => range.start + index).every(number => covered.has(number))) return headers;
  const explicit = explicitAnchors(segments, range);
  return [{
    startNumber: range.start,
    endNumber: range.end,
    headerStart: 0,
    questionStart: explicit.get(range.start) ?? 0,
    sectionEnd: duration
  }];
}

function nearestEvidence(target: number, lower: number, upper: number, average: number, evidence: BoundaryEvidence[], used: Set<number>) {
  return evidence.map((candidate, index) => ({ ...candidate, index, distance: Math.abs(candidate.time - target) }))
    .filter(candidate => !used.has(candidate.index)
      && candidate.time > lower + 0.35
      && candidate.time < upper - 0.35
      && candidate.distance <= Math.min(10, average * 0.28))
    .sort((a, b) => a.distance - b.distance || (b.confidence ?? 0) - (a.confidence ?? 0))[0];
}

function startsFromSections(segments: TranscriptSegment[], duration: number, evidenceInput: BoundaryEvidence[]) {
  const range = detectQuestionRange(segments);
  const sections = buildSections(segments, duration, range);
  const explicit = explicitAnchors(segments, range);
  const evidence = [...evidenceInput, ...captionGapEvidence(segments, duration)]
    .filter(candidate => Number.isFinite(candidate.time) && candidate.time > 0 && candidate.time < duration)
    .sort((a, b) => a.time - b.time);
  const usedEvidence = new Set<number>();
  const starts = new Map<number, BoundaryStart>();

  for (const section of sections) {
    const count = section.endNumber - section.startNumber + 1;
    const average = Math.max(1, (section.sectionEnd - section.questionStart) / count);
    const anchors = new Map<number, BoundaryStart>();
    anchors.set(section.startNumber, {
      time: section.questionStart,
      source: 'range-header',
      confidence: 0.9,
      sourceNumber: section.startNumber
    });
    for (let number = section.startNumber; number <= section.endNumber; number += 1) {
      const time = explicit.get(number);
      if (time !== undefined && time >= section.questionStart - 1 && time < section.sectionEnd) {
        anchors.set(number, { time, source: 'explicit-number', confidence: 0.98, sourceNumber: number });
      }
    }
    const artificialEnd = { time: section.sectionEnd, source: 'range-header' as const, confidence: 0.9, sourceNumber: section.endNumber + 1 };
    for (let number = section.startNumber; number <= section.endNumber; number += 1) {
      const anchored = anchors.get(number);
      if (anchored) {
        starts.set(number, anchored);
        continue;
      }
      const lower = [...anchors.values()].filter(anchor => anchor.sourceNumber < number).sort((a, b) => b.sourceNumber - a.sourceNumber)[0];
      const upper = [...anchors.values(), artificialEnd].filter(anchor => anchor.sourceNumber > number).sort((a, b) => a.sourceNumber - b.sourceNumber)[0];
      const ratio = (number - lower.sourceNumber) / (upper.sourceNumber - lower.sourceNumber);
      const target = lower.time + (upper.time - lower.time) * ratio;
      const candidate = nearestEvidence(target, lower.time, upper.time, average, evidence, usedEvidence);
      if (candidate) {
        usedEvidence.add(candidate.index);
        starts.set(number, { time: candidate.time, source: 'silence-gap', confidence: Math.max(0.64, candidate.confidence ?? 0.68), sourceNumber: number });
      } else {
        starts.set(number, { time: target, source: 'interpolated', confidence: anchors.size >= 2 ? 0.68 : 0.55, sourceNumber: number });
      }
    }
  }

  const ordered = Array.from({ length: 20 }, (_, index) => {
    const sourceNumber = range.start + index;
    return starts.get(sourceNumber) ?? {
      time: index * duration / 20,
      source: 'equal-fallback' as const,
      confidence: 0.25,
      sourceNumber
    };
  });
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].time <= ordered[index - 1].time + 0.25) {
      ordered[index] = { ...ordered[index], time: Math.min(duration, ordered[index - 1].time + Math.max(0.5, duration / 40)), source: 'equal-fallback', confidence: 0.25 };
    }
  }
  return { range, starts: ordered };
}

function questionsFromStarts(segments: TranscriptSegment[], starts: BoundaryStart[], duration: number) {
  const average = duration / 20;
  const headers = rangeHeaders(segments);
  return starts.map((entry, index) => {
    const number = index + 1;
    const start = Math.max(0, entry.time);
    const next = starts[index + 1];
    const nextHeader = next ? headers.find(header => header.startNumber === next.sourceNumber && header.headerStart > start) : null;
    const endTarget = nextHeader ? nextHeader.headerStart - 0.06 : index < 19 ? next.time - 0.06 : duration;
    const end = Math.max(start + 0.5, endTarget);
    const transcript = textInRange(segments, start, end);
    const type = detectType(transcript);
    const endConfidence = next?.confidence ?? 0.9;
    const confidence = Math.min(entry.confidence, endConfidence);
    const flags: string[] = [];
    if (confidence < 0.72) flags.push('BOUNDARY_REVIEW_REQUIRED');
    if (!transcript) flags.push('NO_TRANSCRIPT_IN_RANGE');
    if (type === 'unknown') flags.push('TYPE_REVIEW');
    if (end - start < 3 || end - start > average * 2.4) flags.push('DURATION_OUTLIER');
    return {
      number,
      sourceNumber: entry.sourceNumber,
      start,
      end,
      confidence,
      boundarySource: entry.source,
      type,
      transcript,
      script: transcript,
      questionText: questionTextFrom(transcript),
      choices: parseChoices(transcript),
      correctAnswerIndex: null,
      sourceAudioUrl: null,
      ttsAudioUrl: null,
      flags
    } satisfies ListeningQuestion;
  });
}

export function splitIntoTwenty(segments: TranscriptSegment[], durationInput?: number, evidence: BoundaryEvidence[] = []): ListeningQuestion[] {
  const duration = Math.max(durationInput ?? 0, ...segments.map(segment => segment.end), 1);
  const { starts } = startsFromSections(segments, duration, evidence);
  return questionsFromStarts(segments, starts, duration);
}

export function applyBoundaryProposals(base: ListeningQuestion[], segments: TranscriptSegment[], duration: number, proposals: BoundaryProposal[]) {
  if (base.length !== 20 || proposals.length !== 20) return base;
  const bySource = new Map(proposals.map(proposal => [proposal.sourceNumber, proposal]));
  if (bySource.size !== 20 || base.some(question => !bySource.has(question.sourceNumber))) return base;
  const orderedProposals = base.map(question => bySource.get(question.sourceNumber)!);
  if (orderedProposals.some((proposal, index) => !Number.isFinite(proposal.start) || proposal.start < 0 || proposal.start >= duration
    || (index > 0 && proposal.start <= orderedProposals[index - 1].start + 0.25))) return base;
  const average = duration / 20;
  const starts: BoundaryStart[] = base.map((question, index) => {
    const proposal = orderedProposals[index];
    if (question.boundarySource === 'explicit-number' || question.boundarySource === 'range-header') {
      return { time: question.start, source: question.boundarySource, confidence: Math.max(question.confidence, 0.9), sourceNumber: question.sourceNumber };
    }
    const lower = index === 0 ? 0 : base[index - 1].start + 0.3;
    const upper = index === 19 ? duration - 0.3 : base[index + 1].start - 0.3;
    const closeEnough = Math.abs(proposal.start - question.start) <= Math.max(12, average * 0.5);
    if (!closeEnough || proposal.start <= lower || proposal.start >= upper) {
      return { time: question.start, source: question.boundarySource, confidence: question.confidence, sourceNumber: question.sourceNumber };
    }
    return { time: proposal.start, source: 'agent-verified', confidence: Math.max(0.78, Math.min(0.94, proposal.confidence)), sourceNumber: question.sourceNumber };
  });
  return questionsFromStarts(segments, starts, duration);
}

export function markerCount(segments: TranscriptSegment[]) {
  const range = detectQuestionRange(segments);
  const explicit = explicitAnchors(segments, range).size;
  const headers = rangeHeaders(segments).filter(header => header.endNumber >= range.start && header.startNumber <= range.end);
  return Math.min(20, explicit + headers.length);
}
