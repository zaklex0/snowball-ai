'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/transcription-core');

function audio(rate, seconds, intervals) {
  const samples = new Float32Array(rate * seconds);
  for (const [start, end] of intervals) samples.fill(0.3, Math.floor(start * rate), Math.floor(end * rate));
  return samples;
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 0.1, `${actual} ≠ ${expected}`); }

test('detects speech, joins short gaps, and leaves long pauses between pieces', () => {
  const rate = 16000;
  assert.deepEqual(core.findSpeech(audio(rate, 3, []), rate).pieces, []);
  const result = core.findSpeech(audio(rate, 12, [[1, 3], [3.45, 5], [7, 9]]), rate);
  assert.equal(result.pieces.length, 2);
  near(result.pieces[0].sa, 1); near(result.pieces[0].sb, 5);
  near(result.pieces[1].sa, 7); near(result.pieces[1].sb, 9);
  assert.ok(result.pauses.some(([a, b]) => a >= 3 && b > 3.4 && b < 3.6));
});

test('long continuous speech is split without gaps or pieces over the service limit', () => {
  const rate = 16000;
  const result = core.findSpeech(audio(rate, 65, [[12, 57]]), rate);
  assert.ok(result.pieces.length >= 3);
  for (const piece of result.pieces) assert.ok(piece.b - piece.a <= 20.1);
  for (let i = 1; i < result.pieces.length; i++) near(result.pieces[i - 1].b, result.pieces[i].a);
  near(result.pieces[0].sa, 12); near(result.pieces.at(-1).sb, 57);
});

test('almost continuous sound has an explicit fallback without changing the default threshold', () => {
  const rate = 16000, sample = audio(rate, 50, [[2, 47]]);
  assert.equal(core.findSpeech(sample, rate).pieces.length, 0);
  const retried = core.findSpeech(sample, rate, { flatFallback: true });
  assert.ok(retried.pieces.length >= 3);
  near(retried.pieces[0].sa, 2); near(retried.pieces.at(-1).sb, 47);
  assert.equal(core.findSpeech(audio(rate, 3, []), rate, { flatFallback: true }).pieces.length, 0);
});

test('phrases join across a cut only for the same speaker', () => {
  const cues = core.sentencesOf([
    { start: 1, end: 3, text: 'Первая часть', speaker: 'Анна' },
    { start: 3.3, end: 5, text: 'продолжается.', speaker: 'Анна' },
    { start: 5.2, end: 7, text: 'Другой голос.', speaker: 'Борис' }
  ], []);
  assert.deepEqual(cues, [
    { start: 1, end: 5, text: 'Первая часть продолжается.', speaker: 'Анна' },
    { start: 5.2, end: 7, text: 'Другой голос.', speaker: 'Борис' }
  ]);
  assert.equal(core.speakerText(cues), 'Анна: Первая часть продолжается.\n\nБорис: Другой голос.');
});

test('subtitles retain their text, order, speaker and SRT timing', () => {
  const text = 'Это длинная фраза для проверки субтитров: она должна разделиться на несколько частей, но все слова останутся на месте и будут показаны по порядку без пропусков.';
  const transcript = { cues: [{ start: 1.2, end: 10.8, text, speaker: 'Анна' }], pauses: [[4, 4.3], [7, 7.3]] };
  const subs = core.subtitlesOf(transcript);
  assert.ok(subs.length > 1);
  assert.equal(subs.map((s) => s.text.replace(/\n/g, ' ')).join(' '), 'Анна: ' + text);
  assert.ok(subs.every((s) => s.text.split('\n').length <= 2));
  assert.ok(subs.every((s, i) => s.start <= s.end && (!i || s.start >= subs[i - 1].end)));
  assert.match(core.srtOf(transcript), /^1\n00:00:01,200 --> /);
  assert.equal(core.timingsOf({ cues: [{ start: 1, end: 3, text: 'Привет', speaker: 'Анна' }] }, 'prompt'), '[0:01–0:03] Анна: Привет');
});
