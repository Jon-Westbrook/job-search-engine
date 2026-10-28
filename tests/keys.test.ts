import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCompany, normalizeLocation, normalizeTitle, titleSimilarity } from '../src/server/normalize/keys.ts';

test('company names drop legal suffixes and fold punctuation and accents', () => {
  assert.equal(normalizeCompany('Bestinfo Systems LLC'), 'bestinfo systems');
  assert.equal(normalizeCompany('ESP Associates, Inc.'), 'esp associates');
  assert.equal(normalizeCompany('Lunon Ltd'), 'lunon');
  assert.equal(normalizeCompany('Café Corp'), 'cafe');
  assert.equal(normalizeCompany('S&P Global'), 's and p global');
});

test('a single legal word is kept so the company is not erased', () => {
  assert.equal(normalizeCompany('Inc'), 'inc');
});

test('known aliases map to one company key', () => {
  assert.equal(normalizeCompany('Acme Holdings', { 'acme holdings': 'acme' }), 'acme');
});

test('seniority words stay in titles, so Senior and Director remain distinct', () => {
  assert.equal(normalizeTitle('Senior Design Engineer'), 'senior design engineer');
  assert.notEqual(normalizeTitle('Senior Design Engineer'), normalizeTitle('Design Engineer'));
  assert.equal(normalizeTitle('Director, AI Engineering'), 'director ai engineering');
});

test('location keys drop the metro suffix and punctuation', () => {
  assert.equal(normalizeLocation('New York City Metropolitan Area'), 'new york');
  assert.equal(normalizeLocation('New York, NY'), 'new york ny');
  assert.equal(normalizeLocation(null), null);
});

test('title similarity ignores small connecting words and is 1 for the same role', () => {
  assert.equal(titleSimilarity('director software engineering', 'director of software engineering'), 1);
  assert.ok(titleSimilarity('director software engineering', 'vp sales') < 0.5);
  assert.equal(titleSimilarity('', 'anything'), 0);
});
