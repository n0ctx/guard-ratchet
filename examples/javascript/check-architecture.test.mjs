import test from 'node:test';
import assert from 'node:assert/strict';

import { useGuardFixture } from './guard-fixture.mjs';

const { makeRoot, write, read, run } = useGuardFixture('check-architecture.mjs');

test('允许的依赖通过，并报告解析覆盖、模块数和依赖边', () => {
  const root = makeRoot();
  write(root, 'frontend/app.js', "import { get } from './api/get.js';\nget();\n");
  write(root, 'frontend/api/get.js', 'export function get() {}\n');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2\/2 个正式源码文件已解析，2 个模块 \/ 1 条依赖边/);
});

test('测试、依赖、生成和构建目录不进入正式源码扫描', () => {
  const root = makeRoot();
  write(root, 'frontend/app.js', 'export const app = true;\n');
  write(root, 'backend/tests/bad.test.js', 'export const = ;\n');
  write(root, 'node_modules/pkg/bad.js', 'export const = ;\n');
  write(root, 'vendor/pkg/bad.js', 'export const = ;\n');
  write(root, 'generated/out.js', 'export const = ;\n');
  write(root, 'build/out.js', 'export const = ;\n');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\/1 个正式源码文件已解析/);
});

test('frontend 直接依赖 backend/db 时以稳定 key 作为硬规则失败', () => {
  const root = makeRoot();
  write(root, 'frontend/a.js', "import { get } from '../backend/db/x.js';\nget();\n");
  write(root, 'backend/db/x.js', 'export function get() {}\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forbidden-dependency: frontend\/a\.js -> backend\/db\/x\.js/);
});

test('routes 直接依赖 backend/db 时失败', () => {
  const root = makeRoot();
  write(root, 'backend/routes/user.js', "import { get } from '../db/user.js';\nget();\n");
  write(root, 'backend/db/user.js', 'export function get() {}\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forbidden-dependency: backend\/routes\/user\.js -> backend\/db\/user\.js/);
});

test('跨 feature 使用公开 index 入口通过', () => {
  const root = makeRoot();
  write(root, 'features/a/x.js', "import { y } from '../b/index.js';\ny();\n");
  write(root, 'features/b/index.js', 'export function y() {}\n');
  write(root, 'features/b/internal/y.js', 'export function y() {}\n');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test('跨 feature deep import 产生 internal-api-import', () => {
  const root = makeRoot();
  write(root, 'features/a/x.js', "import { y } from '../b/internal/y.js';\ny();\n");
  write(root, 'features/b/index.js', 'export function y() {}\n');
  write(root, 'features/b/internal/y.js', 'export function y() {}\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /internal-api-import: features\/a\/x\.js -> features\/b\/internal\/y\.js/);
});

test('插入无关代码并新增文件不改变已有 finding key', () => {
  const root = makeRoot();
  write(root, 'frontend/a.js', "import { get } from '../backend/db/x.js';\nget();\n");
  write(root, 'backend/db/x.js', 'export function get() {}\n');
  const first = run(root);
  const key = first.stderr.match(/forbidden-dependency: (.+)/)?.[1];
  assert.equal(first.status, 1);
  assert.equal(key, 'frontend/a.js -> backend/db/x.js');

  write(root, 'frontend/a.js', `const unrelated = 1;\n${read(root, 'frontend/a.js')}`);
  write(root, 'frontend/added.js', 'export const unrelated = true;\n');
  const after = run(root);
  assert.equal(after.status, 1);
  assert.ok(after.stderr.includes(`forbidden-dependency: ${key}`));
});

test('源码解析失败、静态引用无法解析和空扫描都 fail closed', () => {
  const parseRoot = makeRoot();
  write(parseRoot, 'frontend/bad.js', 'export const = ;\n');
  const parseResult = run(parseRoot);
  assert.equal(parseResult.status, 1);
  assert.match(parseResult.stderr, /解析失败：frontend\/bad\.js/);

  const importRoot = makeRoot();
  write(importRoot, 'frontend/a.js', "import './missing.js';\n");
  const importResult = run(importRoot);
  assert.equal(importResult.status, 1);
  assert.match(importResult.stderr, /无法解析仓内静态引用：frontend\/a\.js -> \.\/missing\.js/);

  const emptyResult = run(makeRoot());
  assert.equal(emptyResult.status, 1);
  assert.match(emptyResult.stderr, /没有扫到任何正式源码文件/);
});

test('显式基线模式覆盖现状相等、新增和 stale 三种棘轮结果', () => {
  const root = makeRoot();
  write(root, 'backend/routes/user.js', "import '../db/user.js';\n");
  write(root, 'backend/db/user.js', 'export const user = 1;\n');

  const update = run(root, '--baseline-mode', '--update-baseline');
  assert.equal(update.status, 0, update.stderr);
  assert.deepEqual(JSON.parse(read(root, 'scripts/architecture-baseline.json')).findings,
    ['forbidden-dependency:backend/routes/user.js -> backend/db/user.js']);
  assert.equal(run(root, '--baseline-mode').status, 0);

  write(root, 'backend/routes/team.js', "import '../db/team.js';\n");
  write(root, 'backend/db/team.js', 'export const team = 1;\n');
  const added = run(root, '--baseline-mode');
  assert.equal(added.status, 1);
  assert.match(added.stderr, /新增架构边界违规/);

  write(root, 'backend/routes/user.js', 'export const user = 1;\n');
  write(root, 'backend/routes/team.js', 'export const team = 1;\n');
  const stale = run(root, '--baseline-mode');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /基线与现状对不上/);
});
