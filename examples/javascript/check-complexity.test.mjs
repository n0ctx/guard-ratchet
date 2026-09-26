import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

test('复杂度等于门槛不报，超过门槛才报', () => {
  const root = fixture();
  write(root, 'backend/boundary.js', branchy('atLimit', 29) + branchy('aboveLimit', 30));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /boundary\.js#atLimit/);
  assert.match(result.stderr, /boundary\.js#aboveLimit: 31/);
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

test('解析失败和低于函数覆盖下限时失败，且不能写基线', () => {
  const root = fixture();
  const baselinePath = path.join(root, 'scripts/complexity-baseline.json');
  const baselineBefore = readFileSync(baselinePath, 'utf8');
  write(root, 'backend/bad.js', 'export const = ;\n');
  const parseFailure = run(root);
  assert.equal(parseFailure.status, 1);
  assert.match(parseFailure.stderr, /解析失败：backend\/bad\.js/);

  const update = run(root, '--update-baseline');
  assert.equal(update.status, 1);
  assert.match(update.stderr, /detector health 不通过/);
  assert.equal(readFileSync(baselinePath, 'utf8'), baselineBefore);

  const empty = run(makeRoot());
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /扫到的函数过少/);
});

test('匿名函数按「外层函数名>调用名」命名，前面多一个函数不会让 key 错位', () => {
  const root = makeRoot();
  write(root, 'backend/many.js', Array.from({ length: 1500 }, (_, i) => `export function f${i}() {}`).join('\n'));
  const callback = Array.from({ length: 31 }, (_, i) => `    if (x === ${i}) return ${i};`).join('\n');
  const source = (extra) => `${extra}export function match(items) {\n  return items.filter((x) => {\n${callback}\n    return false;\n  });\n}\n`;
  write(root, 'backend/match.js', source(''));
  assert.equal(run(root, '--update-baseline').status, 0);
  write(root, 'backend/match.js', source('setTimeout(() => {}, 0);\n'));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path.join(root, 'scripts/complexity-baseline.json'), 'utf8'), /backend\/match\.js#match>filter/);
});
