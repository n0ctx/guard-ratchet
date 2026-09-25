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
