#!/usr/bin/env node
/**
 * 测试形态守卫：只看测试源码的形状，不运行测试、不读耗时
 *
 * 扫描 backend/tests、assistant/tests、frontend 下的 *.test.{js,jsx,mjs} 与 *.spec.*。
 *
 * 直接失败（不进基线）：
 *   - 测试体里没有任何断言（assert / node:assert 导入的函数 / expect( / 测试对象的 .plan( / t.assert.*）
 *   - 提交了 test.only / it.only / describe.only 或 { only: true }（会让同文件其余测试不跑）
 *   - 只比较字面量的空断言：assert.ok(true)、assert.equal(1, 1)、expect(true).toBe(true)
 *   - 非端到端测试里出现 waitForTimeout，或 setTimeout / sleep 的延迟字面量 > MAX_DELAY_MS
 *   - playwright 出现在端到端目录 backend/tests/e2e 之外
 *   - backend/package.json 的 test / test:coverage 会扫到 tests/e2e
 *
 * 记入 scripts/test-shape-baseline.json，只许降不许新增：
 *   - 每个测试文件里 listen( / initSchema( / chromium.launch 的次数（新文件超过 1 次算失败）；
 *     在同一函数里 listen 后马上 close 的是探测空闲端口，不算启动服务
 *   - test.skip / it.skip / describe.skip 的位置（文件 + 标题）
 *
 * 有意重复初始化（例如验证重复执行不出错）用 `// guard-allow(tests): 理由` 标在调用旁边，
 * 规则见 guard-common.mjs。
 *
 * 用法：
 *   node scripts/check-tests.mjs [--root <dir>] [--baseline <path>] [--update-baseline]
 *
 * 退出码：0 通过 / 1 存在违规
 */

import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  BASELINE_NOTE, allowFailures, baselineFailures, collectAllowMarkers, collectCodeFiles, compareCounts, compareSets, countKeys, finish, loadBaseline,
  parseArgs, parseFiles, section, stringValue, suffixDuplicates, walk, writeBaseline,
} from './guard-common.mjs';

const SCRIPT = 'check-tests.mjs';
const DEFAULT_BASELINE = path.join('scripts', 'test-shape-baseline.json');
const SCAN_DIRS = ['backend/tests', 'assistant/tests', 'frontend'];
const TEST_FILE_RE = /\.(test\.(js|jsx|mjs)|spec\.[^./]+)$/;
const E2E_DIR = 'backend/tests/e2e/';
const BACKEND_TEST_SCRIPTS = ['test', 'test:coverage'];
const MAX_DELAY_MS = 50;

const TEST_NAMES = new Set(['test', 'it']);
// test.before / it.skip 这类不是要求断言的测试体
const NON_TEST_MODIFIERS = new Set(['skip', 'todo', 'before', 'after', 'beforeEach', 'afterEach']);
const SUITE_NAMES = new Set(['test', 'it', 'describe']);
const ASSERT_MODULES = new Set(['assert', 'assert/strict', 'node:assert', 'node:assert/strict']);
// 比较前两个参数的断言方法；ok 和直接调用 assert(x) 只看第一个参数
const COMPARE_ASSERTS = new Set([
  'equal', 'strictEqual', 'deepEqual', 'deepStrictEqual',
  'notEqual', 'notStrictEqual', 'notDeepEqual', 'notDeepStrictEqual',
]);
const HEAVY_SETUP = ['listen', 'initSchema', 'chromium.launch'];
const FUNCTION_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression']);

// ─── AST 小工具 ──────────────────────────────────────────────────────────────
// 成员链/调用链最左边的标识符：expect(x).toBe → expect，assert.strictEqual → assert
function rootName(node) {
  let cur = node;
  while (cur) {
    if (cur.type === 'Identifier') return cur.name;
    cur = cur.type === 'MemberExpression' ? cur.object : cur.type === 'CallExpression' ? cur.callee : null;
  }
  return null;
}

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed) {
    const obj = callee.object.type === 'Identifier' ? `${callee.object.name}.` : '';
    return `${obj}${callee.property.name}`;
  }
  return null;
}

const lastName = (name) => name?.split('.').pop();

// test(...) / it.only(...) / it.each(rows)(...) → { root, modifier }
function testCall(node) {
  let callee = node.callee;
  if (callee.type === 'CallExpression') callee = callee.callee;
  if (callee.type === 'Identifier' && SUITE_NAMES.has(callee.name)) return { root: callee.name, modifier: null };
  if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier'
      && SUITE_NAMES.has(callee.object.name) && !callee.computed) {
    return { root: callee.object.name, modifier: callee.property.name };
  }
  return null;
}

function assertLocals(tree) {
  const names = new Set(['assert', 'expect']);
  for (const node of tree.body) {
    if (node.type !== 'ImportDeclaration' || !ASSERT_MODULES.has(node.source.value)) continue;
    node.specifiers.forEach((s) => names.add(s.local.name));
  }
  return names;
}

function isAssertion(node, assertNames, contextName) {
  if (node.type !== 'CallExpression') return false;
  if (assertNames.has(rootName(node.callee))) return true;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return false;
  if (callee.object.name !== contextName) return false;
  return callee.property.name === 'plan';
}

function hasAssertion(fn, assertNames) {
  const contextName = fn.params[0]?.type === 'Identifier' ? fn.params[0].name : null;
  for (const [node] of walk(fn.body)) {
    if (isAssertion(node, assertNames, contextName)) return true;
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier'
        && node.object.name === contextName && node.property.name === 'assert') return true;
  }
  return false;
}

const isLiteral = (node) => node?.type === 'Literal'
  || (node?.type === 'UnaryExpression' && node.argument.type === 'Literal');

// assert.ok(true) / t.assert.equal(1, 1) / expect(true).toBe(true) 这类结果写死的断言
function isTrivialAssertion(node, assertNames) {
  const { callee } = node;
  if (callee.type === 'MemberExpression' && callee.object.type === 'CallExpression'
      && callee.object.callee.type === 'Identifier' && callee.object.callee.name === 'expect') {
    return isLiteral(callee.object.arguments[0]) && node.arguments.every(isLiteral);
  }
  let method = null;
  if (callee.type === 'Identifier' && assertNames.has(callee.name)) method = callee.name === 'assert' ? 'ok' : callee.name;
  else if (callee.type === 'MemberExpression' && !callee.computed) {
    const owner = callee.object;
    const isAssertObject = (owner.type === 'Identifier' && owner.name === 'assert')
      || (owner.type === 'MemberExpression' && !owner.computed && owner.property.name === 'assert');
    if (isAssertObject) method = callee.property.name;
  }
  if (method === 'ok') return isLiteral(node.arguments[0]);
  return COMPARE_ASSERTS.has(method) && isLiteral(node.arguments[0]) && isLiteral(node.arguments[1]);
}

// ─── 单文件检查 ──────────────────────────────────────────────────────────────
function checkFocusAndTrivial(file, call, found) {
  const where = `${file.rel}:${call.loc.start.line}`;
  const info = testCall(call);
  const onlyOption = info && call.arguments.some((a) => a.type === 'ObjectExpression' && a.properties.some(
    (p) => p.type === 'Property' && (p.key.name ?? p.key.value) === 'only' && p.value.value === true));
  if (info?.modifier === 'only' || onlyOption) found.hard.push(`${where} 提交了 ${info.root}.only，同文件其余测试会被跳过`);
  if (isTrivialAssertion(call, found.assertNames)) found.hard.push(`${where} 断言只比较字面量，结果写死，等于没测`);
}

function checkAssertions(file, call, found) {
  const info = testCall(call);
  if (!info || !TEST_NAMES.has(info.root) || NON_TEST_MODIFIERS.has(info.modifier)) return;
  const fn = [...call.arguments].reverse().find((a) => FUNCTION_TYPES.has(a.type));
  if (!fn || hasAssertion(fn, found.assertNames)) return;
  const title = stringValue(call.arguments[0]) ?? '(匿名)';
  found.hard.push(`${file.rel}:${call.loc.start.line} 测试「${title}」没有任何断言`);
}

function checkDelays(file, call, found) {
  if (file.rel.startsWith(E2E_DIR)) return;
  const name = lastName(calleeName(call.callee));
  const where = `${file.rel}:${call.loc.start.line}`;
  if (name === 'waitForTimeout') found.hard.push(`${where} 非端到端测试不许用 waitForTimeout`);
  const delay = name === 'setTimeout' ? call.arguments[1] : name === 'sleep' ? call.arguments[0] : null;
  if (delay?.type === 'Literal' && typeof delay.value === 'number' && delay.value > MAX_DELAY_MS) {
    found.hard.push(`${where} ${name} 延迟 ${delay.value}ms，非端到端测试上限 ${MAX_DELAY_MS}ms`);
  }
}

function moduleSource(node) {
  if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') return stringValue(node.source);
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
    return stringValue(node.arguments[0]);
  }
  return null;
}

function checkPlaywright(file, node, found) {
  if (file.rel.startsWith(E2E_DIR)) return;
  const source = moduleSource(node);
  if (source && /^(@playwright\/|playwright)/.test(source)) {
    found.hard.push(`${file.rel}:${node.loc.start.line} playwright 只允许出现在 ${E2E_DIR}`);
  }
}

// server.listen(...) 所在的 server 变量，在声明它的函数里又被 server.close(...)：探测空闲端口
function isPortProbe(file, call) {
  const obj = call.callee.type === 'MemberExpression' ? call.callee.object : null;
  if (obj?.type !== 'Identifier') return false;
  let owner = null;
  for (const [node, parent] of walk(file.tree)) {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === obj.name
        && node.range[0] < call.range[0]) owner = parent;
  }
  const scope = owner && [...walk(file.tree)].map(([n]) => n)
    .filter((n) => FUNCTION_TYPES.has(n.type) || n.type === 'FunctionDeclaration')
    .filter((fn) => fn.range[0] <= owner.range[0] && owner.range[1] <= fn.range[1])
    .sort((a, b) => (a.range[1] - a.range[0]) - (b.range[1] - b.range[0]))[0];
  if (!scope) return false;
  return [...walk(scope)].some(([n]) => n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
    && n.callee.object.type === 'Identifier' && n.callee.object.name === obj.name
    && !n.callee.computed && n.callee.property.name === 'close');
}

function recordShape(file, call, found) {
  const name = calleeName(call.callee);
  const metric = HEAVY_SETUP.find((m) => m === name || (!m.includes('.') && lastName(name) === m));
  if (metric && !(metric === 'listen' && isPortProbe(file, call))
      && !found.allow.covers(file.rel, call.loc.start.line)) {
    found.heavy.push(`${file.rel}#${metric}`);
  }
  const info = testCall(call);
  if (info?.modifier === 'skip' && call.callee.type === 'MemberExpression') {
    found.skips.push(`${file.rel}#${info.root}.skip ${stringValue(call.arguments[0]) ?? '(匿名)'}`);
  }
}

function inspectFile(file, found) {
  found.assertNames = assertLocals(file.tree);
  for (const [node] of walk(file.tree)) {
    checkPlaywright(file, node, found);
    if (node.type !== 'CallExpression') continue;
    checkAssertions(file, node, found);
    checkFocusAndTrivial(file, node, found);
    checkDelays(file, node, found);
    recordShape(file, node, found);
  }
}

// ─── backend 默认测试命令 ─────────────────────────────────────────────────────
function scriptTargets(cmd) {
  return cmd.split(/\s+/).slice(1)
    .map((w) => w.replace(/^['"]|['"]$/g, ''))
    .filter((w) => w && !w.startsWith('-') && !/^\w+=/.test(w) && w !== 'node');
}

function scansE2E(backendDir, cmd) {
  const targets = scriptTargets(cmd);
  if (!targets.length) return true;
  return targets.some((target) => {
    const abs = path.join(backendDir, target);
    if (existsSync(abs) && statSync(abs).isDirectory()) return 'tests/e2e/'.startsWith(`${path.posix.normalize(target)}/`);
    return globSync(target, { cwd: backendDir }).some((f) => f.split(path.sep).join('/').startsWith('tests/e2e/'));
  });
}

function checkBackendScripts(root) {
  const pkgPath = path.join(root, 'backend', 'package.json');
  if (!existsSync(pkgPath)) return ['找不到 backend/package.json'];
  const scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {};
  const problems = [];
  for (const name of BACKEND_TEST_SCRIPTS) {
    if (!scripts[name]) problems.push(`backend/package.json 缺少 ${name} 命令`);
    else if (scansE2E(path.join(root, 'backend'), scripts[name])) {
      problems.push(`backend/package.json 的 ${name} 会扫到 tests/e2e（浏览器测试只许单独跑）`);
    }
  }
  return problems;
}

// ─── 汇总 ────────────────────────────────────────────────────────────────────
function collectTestShape(root) {
  const rels = SCAN_DIRS.flatMap((dir) => collectCodeFiles(root, dir))
    .filter((rel) => TEST_FILE_RE.test(rel));
  const { parsed, parseFailures } = parseFiles(root, rels);
  const allow = collectAllowMarkers(parsed, 'tests');
  const found = { hard: checkBackendScripts(root), heavy: [], skips: [], allow };
  for (const file of parsed) inspectFile(file, found);
  return {
    allow,
    hard: found.hard,
    heavySetup: countKeys(found.heavy),
    skips: suffixDuplicates(found.skips),
    parseFailures,
    fileCount: rels.length,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2), DEFAULT_BASELINE);
  const shape = collectTestShape(args.root);
  const heavyOver = Object.fromEntries(Object.entries(shape.heavySetup).filter(([, n]) => n > 1).sort());

  if (args.updateBaseline && !shape.parseFailures.length) {
    writeBaseline(args.baselinePath, { heavySetup: heavyOver, skips: shape.skips });
    console.log(`[tests] 基线已更新\nFile: ${path.relative(args.root, args.baselinePath)}\n`
      + `测试文件: ${shape.fileCount}（重复起服务/建库 ${Object.keys(heavyOver).length} 处、跳过 ${shape.skips.length} 条写入基线）`);
    process.exit(0);
  }

  const failures = [];
  if (shape.fileCount === 0) failures.push('没有扫到任何测试文件，遍历逻辑可能坏了');
  for (const rel of shape.parseFailures) failures.push(`解析失败：${rel}（espree 无法解析，请检查语法）`);
  if (shape.hard.length) failures.push(section('测试形态违规（不进基线，必须改掉）：', shape.hard));

  let baseline;
  try {
    baseline = loadBaseline(args.baselinePath, { heavySetup: {}, skips: [] });
  } catch (err) {
    finish('测试形态守卫', [err.message], `扫描 ${shape.fileCount} 个测试文件`);
  }
  failures.push(...baselineFailures(compareCounts(shape.heavySetup, baseline.heavySetup || {}, { allowed: 1 }), {
    script: SCRIPT, addedTitle: `这些测试文件里 ${HEAVY_SETUP.join(' / ')} 超过 1 次，而且不在基线里；共用一次启动`,
  }));
  failures.push(...baselineFailures(compareSets(shape.skips, baseline.skips || []), {
    script: SCRIPT, addedTitle: '新增了永久跳过的测试；修好或删掉',
  }));
  failures.push(...allowFailures(shape.allow));

  finish('测试形态守卫', failures, `${shape.fileCount} 个测试文件`, BASELINE_NOTE, shape.allow.listing());
}

main();
