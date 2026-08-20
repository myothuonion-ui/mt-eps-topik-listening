import assert from 'node:assert/strict';
import { markerCount, splitIntoTwenty } from '../server/services/splitter.js';
import type { TranscriptSegment } from '../src/shared.js';

const segments: TranscriptSegment[] = Array.from({ length: 20 }, (_, i) => ({ start: i * 10, end: i * 10 + 8, text: `${i + 1}번 다음을 듣고 알맞은 것을 고르십시오. 테스트 대화입니다.`, source: 'caption' }));
assert.equal(markerCount(segments), 20);
const questions = splitIntoTwenty(segments, 200);
assert.equal(questions.length, 20);
assert.equal(questions[0].number, 1);
assert.equal(questions[19].number, 20);
assert.equal(questions.every(q => q.boundarySource === 'explicit-number'), true);
console.log('Smoke PASS: explicit Q1-Q20 transcript -> 20 listening slots.');
