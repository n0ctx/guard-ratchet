import test from 'node:test';
import assert from 'node:assert/strict';

import { useGuardFixture } from './guard-fixture.mjs';

const { makeRoot, write, run } = useGuardFixture('check-cycles.mjs');

function fixture() {
  const root = makeRoot();
  write(root, 'backend/a.js', "import { b } from './b.js';\nexport const a = () => b;\n");
  write(root, 'backend/b.js', "export const b = 1;\nexport const lazy = () => import('./a.js');\n");
  write(root, 'backend/tests/a.test.js', "import { a } from '../a.js';\nexport const x = a;\n");
  return root;
}

test('没有循环时通过，import() 与测试文件不算循环', () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stderr);
});

test('静态 import 成环时失败', () => {
  const root = fixture();
  write(root, 'backend/b.js', "import { a } from './a.js';\nexport const b = 1;\nexport const c = () => a;\n");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backend\/a\.js ↔ backend\/b\.js/);
});

test('解析失败、无法解析的静态引用、空扫描都失败', () => {
  const parseRoot = makeRoot();
  write(parseRoot, 'backend/bad.js', 'export const = ;\n');
  const parseFailure = run(parseRoot);
  assert.equal(parseFailure.status, 1);
  assert.match(parseFailure.stderr, /解析失败：backend\/bad\.js/);

  const importRoot = makeRoot();
  write(importRoot, 'backend/a.js', "import './missing.js';\n");
  const unresolved = run(importRoot);
  assert.equal(unresolved.status, 1);
  assert.match(unresolved.stderr, /无法解析仓内静态引用：backend\/a\.js -> \.\/missing\.js/);

  const empty = run(makeRoot());
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /没有扫到任何文件/);
});
