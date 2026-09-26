import test from 'node:test';
import assert from 'node:assert/strict';

import { useGuardFixture } from './guard-fixture.mjs';

const { makeRoot, write, run } = useGuardFixture('check-tests.mjs');
const GLOB = '"tests/{*.test.js,!(e2e)/**/*.test.js}"';

function fixture() {
  const root = makeRoot();
  write(root, 'backend/package.json', JSON.stringify({
    scripts: { test: `node --test ${GLOB}`, 'test:coverage': `node --test --experimental-test-coverage ${GLOB}` },
  }));
  write(root, 'backend/tests/a.test.js', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    'test.before(() => {});',
    "test('ok', () => { assert.equal(sum(1, 1), 2); });",
    "test('plan', (t) => { t.plan(1); t.assert.ok(ready()); });",
    "test.skip('pending', () => {});",
    'server.listen(0); server.listen(0);',
    '',
  ].join('\n'));
  write(root, 'backend/tests/e2e/ui.test.js', [
    "import { chromium } from 'playwright';",
    "test('ui', async () => { await page.waitForTimeout(500); expect(await title()).toBe('x'); });",
    '',
  ].join('\n'));
  write(root, 'frontend/src/x.test.jsx', "it('renders', async () => { await sleep(20); expect(view()).toBe(1); });\n");
  assert.equal(run(root, '--update-baseline').status, 0);
  return root;
}

test('现状与基线一致时通过', () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stderr);
});

test('新增无断言测试、长延迟、playwright 越界、默认命令扫到 e2e 都失败', () => {
  const root = fixture();
  write(root, 'frontend/src/y.test.js', [
    "import { test } from '@playwright/test';",
    "it('no assert', () => { run(); });",
    "it('slow', async () => { await new Promise((r) => setTimeout(r, 51)); expect(view()).toBe(1); });",
    '',
  ].join('\n'));
  write(root, 'backend/package.json', JSON.stringify({
    scripts: { test: 'node --test "tests/**/*.test.js"', 'test:coverage': `node --test ${GLOB}` },
  }));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /「no assert」没有任何断言/);
  assert.match(result.stderr, /setTimeout 延迟 51ms/);
  assert.match(result.stderr, /y\.test\.js:1 playwright 只允许出现在/);
  assert.match(result.stderr, /的 test 会扫到 tests\/e2e/);
  assert.doesNotMatch(result.stderr, /test:coverage 会扫到/);
});

test('提交 .only 或写死结果的断言失败', () => {
  const root = fixture();
  write(root, 'backend/tests/b.test.js', [
    "import assert from 'node:assert/strict';",
    "test.only('focus', () => { assert.equal(sum(1, 2), 3); });",
    "test('option', { only: true }, () => { assert.ok(ready()); });",
    "test('fake', (t) => { assert.ok(true); t.assert.equal(1, 1); expect(true).toBe(true); });",
    '',
  ].join('\n'));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /b\.test\.js:2 提交了 test\.only/);
  assert.match(result.stderr, /b\.test\.js:3 提交了 test\.only/);
  assert.equal(result.stderr.match(/b\.test\.js:4 断言只比较字面量/g).length, 3);
});

test('固定等待等于 50ms 不报，超过上限才报', () => {
  const root = fixture();
  const source = (ms) => [
    "import { test } from 'node:test';",
    `test('wait', async () => { await new Promise((resolve) => setTimeout(resolve, ${ms})); expect(view()).toBe(1); });`,
    '',
  ].join('\n');
  write(root, 'frontend/src/boundary.test.js', source(50));
  assert.equal(run(root).status, 0);
  write(root, 'frontend/src/boundary.test.js', source(51));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /setTimeout 延迟 51ms/);
});

test('基线里的跳过删掉后未清理算虚挂', () => {
  const root = fixture();
  write(root, 'backend/tests/a.test.js', "import assert from 'node:assert';\ntest('ok', () => { assert.ok(ready()); });\n");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /基线与现状对不上[\s\S]*a\.test\.js#test\.skip pending/);
  assert.match(result.stderr, /a\.test\.js#listen: 记的是 2，实际 0/);
});

test('在跳过用例前增加无关测试，不改变已有跳过 key', () => {
  const root = fixture();
  write(root, 'backend/tests/a.test.js', [
    "import assert from 'node:assert/strict';",
    "test('unrelated', () => { assert.ok(ready()); });",
    "test.skip('pending', () => {});",
    'server.listen(0); server.listen(0);',
    '',
  ].join('\n'));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test('解析失败或没有测试文件时 detector health 失败，不能更新基线', () => {
  const root = fixture();
  write(root, 'backend/tests/bad.test.js', 'test(,);\n');
  const parseFailure = run(root);
  assert.equal(parseFailure.status, 1);
  assert.match(parseFailure.stderr, /解析失败：backend\/tests\/bad\.test\.js/);

  const update = run(root, '--update-baseline');
  assert.equal(update.status, 1);
  assert.match(update.stderr, /detector health 不通过/);

  const empty = run(makeRoot());
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /没有扫到任何测试文件/);

  const noCases = makeRoot();
  write(noCases, 'backend/package.json', JSON.stringify({
    scripts: { test: `node --test ${GLOB}`, 'test:coverage': `node --test ${GLOB}` },
  }));
  write(noCases, 'backend/tests/helper.test.js', 'export const helper = 1;\n');
  const coverageFailure = run(noCases);
  assert.equal(coverageFailure.status, 1);
  assert.match(coverageFailure.stderr, /识别到的测试用例过少/);
});

test('listen 后在同一函数里 close 的端口探测不算启动，guard-allow 标记的调用不计数', () => {
  const root = fixture();
  write(root, 'backend/tests/b.test.js', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    'async function freePort() { const probe = createServer(); probe.listen(0); await probe.close(); }',
    "test('x', async () => { await freePort(); server.listen(0);",
    '  // guard-allow(tests): 验证重复初始化不出错',
    '  initSchema(db);',
    '  initSchema(db);',
    '  assert.ok(ready()); });',
    '',
  ].join('\n'));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /b\.test\.js:5 验证重复初始化不出错/);
});
