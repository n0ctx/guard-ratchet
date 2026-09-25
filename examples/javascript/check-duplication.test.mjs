import test from 'node:test';
import assert from 'node:assert/strict';

import { useGuardFixture } from './guard-fixture.mjs';

const { makeRoot, write, run } = useGuardFixture('check-duplication.mjs');

const block = (name) => `export function ${name}(items) {
  let total = 0;
  for (const item of items) {
    if (item.enabled && item.value > 10) total += item.value * 2;
    else total -= item.value;
  }
  return total;
}
`;

function fixture() {
  const root = makeRoot();
  write(root, 'backend/a.js', block('sumA'));
  write(root, 'backend/b.js', block('sumB'));
  write(root, 'backend/tests/c.test.js', block('sumC'));
  assert.equal(run(root, '--update-baseline').status, 0);
  return root;
}

test('现状与基线一致时通过', () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stderr);
});

test('同一文件里新复制一段失败', () => {
  const root = fixture();
  const loop = 'for (const row of rows) { if (row.id > 3 && row.name !== "x") { out.push({ id: row.id, name: row.name, tag: "t" }); } }\n';
  write(root, 'frontend/src/d.js', `const out = [];\n${loop}console.log(out.length);\n${loop}`);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /frontend\/src\/d\.js:2-2、frontend\/src\/d\.js:4-4/);
});

test('基线里的重复消失后未清理算虚挂', () => {
  const root = fixture();
  write(root, 'backend/b.js', 'export const b = 1;\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /基线与现状对不上/);
});

const setters = (source) => ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
  .map((field) => `set_${source}_${field}(${source}.${field}_value);`).join('\n');

test('只差名字的一串简单调用不算重复', () => {
  const root = fixture();
  write(root, 'frontend/src/d.js', `${setters('prompt')}\n`);
  write(root, 'frontend/src/e.js', `${setters('display')}\n`);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test('逐字相同的一串简单调用仍算重复', () => {
  const root = fixture();
  write(root, 'frontend/src/d.js', `${setters('prompt')}\n`);
  write(root, 'frontend/src/e.js', `${setters('prompt')}\n`);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /frontend\/src\/d\.js:1-6、frontend\/src\/e\.js:1-6/);
});

test('guard-allow 标记的那处出现不计入，不足两处的重复组不报', () => {
  const root = fixture();
  write(root, 'backend/c.js', `// guard-allow(duplication): 与 a.js 必须逐字一致的镜像\n${block('sumC')}`);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /backend\/c\.js:1 与 a\.js 必须逐字一致的镜像/);
});
