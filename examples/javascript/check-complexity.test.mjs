import test from 'node:test';
import assert from 'node:assert/strict';

import { useGuardFixture } from './guard-fixture.mjs';

const { makeRoot, write, run } = useGuardFixture('check-complexity.mjs');

// branches 个 if 的函数，复杂度 = branches + 1
const branchy = (name, branches) => `export function ${name}(x) {\n${
  Array.from({ length: branches }, (_, i) => `  if (x === ${i}) return ${i};`).join('\n')}\n  return -1;\n}\n`;

function fixture() {
  const root = makeRoot();
  // 守卫要求至少扫到 1500 个函数，否则判定遍历坏了
  write(root, 'backend/many.js', Array.from({ length: 1500 }, (_, i) => `export function f${i}() {}`).join('\n'));
  write(root, 'backend/legacy.js', branchy('legacy', 40));
  assert.equal(run(root, '--update-baseline').status, 0);
  return root;
}

test('现状与基线一致时通过', () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stderr);
});

test('新增超标函数或基线函数变复杂都失败', () => {
  const root = fixture();
  write(root, 'backend/fresh.js', branchy('fresh', 31));
  write(root, 'backend/legacy.js', branchy('legacy', 45));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backend\/fresh\.js#fresh: 32/);
  assert.match(result.stderr, /backend\/legacy\.js#legacy: 41 → 46/);
});

test('把判断剪到只被一处调用的私有函数，调用方分数不降', () => {
  const root = fixture();
  write(root, 'backend/legacy.js', `function step(x) {
  if (x === 1) return 1;
  if (x === 2) return 2;
  return 0;
}
export function legacy(x) {
  step(x);
${Array.from({ length: 38 }, (_, i) => `  if (x === ${i + 3}) return ${i};`).join('\n')}
  return -1;
}
`);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test('私有函数被两处调用时单独计分，原函数不再背它的判断', () => {
  const root = fixture();
  write(root, 'backend/legacy.js', `function step(x) {
  if (x === 1) return 1;
  return 0;
}
export function legacy(x) {
  step(x);
  return -1;
}
export function other(x) {
  step(x);
  return -1;
}
`);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backend\/legacy\.js#legacy: 记的是 41，实际 1/);
});

test('基线函数简化后未更新算虚挂', () => {
  const root = fixture();
  write(root, 'backend/legacy.js', branchy('legacy', 10));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backend\/legacy\.js#legacy: 记的是 41，实际 11/);
});
