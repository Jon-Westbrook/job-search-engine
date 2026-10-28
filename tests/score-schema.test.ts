import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExtraction } from '../src/server/score/extract.ts';

const valid = () => ({
  tn: { class: 'design_centric', evidence: [{ quote: 'Design Engineer', field: 'title' }] },
  role: {
    seniority_match: { value: 0.8, evidence: [] },
    design_engineering_balance: { value: 0.8, evidence: [] },
    stack_overlap: { value: 0.9, evidence: [] },
  },
  role_family: 'design engineering',
  missing: ['pay'],
});

test('a well-formed extraction passes', () => {
  assert.equal(validateExtraction(valid()).ok, true);
});

test('the model cannot return a score: an extra score field fails validation', () => {
  const out = validateExtraction({ ...valid(), score: 100 });
  assert.equal(out.ok, false);
});

test('values outside 0 to 1, unknown classes, and unknown evidence fields fail', () => {
  const bad = valid();
  bad.role.stack_overlap.value = 1.5;
  assert.equal(validateExtraction(bad).ok, false);
  const badClass = { ...valid(), tn: { class: 'maybe', evidence: [] } };
  assert.equal(validateExtraction(badClass).ok, false);
  const badField = { ...valid(), tn: { class: 'partial', evidence: [{ quote: 'x', field: 'email' }] } };
  assert.equal(validateExtraction(badField).ok, false);
});

test('more than three evidence quotes fails', () => {
  const many = { ...valid(), tn: { class: 'partial', evidence: [1, 2, 3, 4].map((i) => ({ quote: `q${i}`, field: 'title' })) } };
  assert.equal(validateExtraction(many).ok, false);
});

test('missing required keys fail', () => {
  const { role: _role, ...noRole } = valid();
  assert.equal(validateExtraction(noRole).ok, false);
});

test('the schema reports at most ten readable errors', () => {
  const out = validateExtraction({});
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.length > 0 && out.errors.length <= 10);
});
