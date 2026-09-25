#!/usr/bin/env node
/**
 * 圈复杂度止血闸：新代码不许超过阈值，旧代码只许往下走
 *
 * 移植自 casim 的 tests/test_complexity.py。不是「复杂度高就是坏」——有些函数
 * 对齐多个异构系统，那是固有复杂度。真正的问题是不知不觉地涨：一个函数从 20
 * 涨到 50 从来不是一次改动干的。所以这里只做两件事：
 *
 * 1. 新函数一律 ≤ LIMIT（30）；
 * 2. 已超标函数写进 scripts/complexity-baseline.json，各自的值只许降不许升——
 *    降了要顺手改小（--update-baseline），改小这个动作本身就是记录「这次真的简化了」。
 *
 * 复杂度算法是自带的近似式（分支/循环/catch/三元/逻辑运算符各计一），数值与
 * 专业工具不完全相同也没关系——它只用来和自己的历史比。
 *
 * 用法：
 *   node scripts/check-complexity.mjs [--root <dir>] [--baseline <path>] [--update-baseline] [--ignore <glob>]
 *
 * 退出码：0 通过 / 1 存在违规（新增超标、基线上涨、基线虚挂）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const espree = require('espree');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// --root 可改为扫描别的目录（守卫自身的夹具测试用）
let ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASELINE = path.join('scripts', 'complexity-baseline.json');
const BASELINE_VERSION = 1;

const LIMIT = 30;
// 扫到的函数总数低于此值说明遍历逻辑坏了（防空转通过）
const MIN_FUNCTION_COUNT = 1500;

const CODE_SUFFIXES = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'coverage', 'build', 'test-results',
  'data', 'node-runtime', '__pycache__',
]);

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const DECISION_NODES = new Set([
  'IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement', 'CatchClause', 'ConditionalExpression',
]);

// ─── 遍历 ────────────────────────────────────────────────────────────────────
function collectFiles(dir, relPrefix, extraIgnores, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      if (extraIgnores.some((p) => matchGlob(rel, p))) continue;
      collectFiles(path.join(dir, entry.name), rel, extraIgnores, out);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.lock') || entry.name.endsWith('.snap')) continue;
      if (extraIgnores.some((p) => matchGlob(rel, p))) continue;
      if (CODE_SUFFIXES.has(path.extname(entry.name).toLowerCase())) out.push(rel);
    }
  }
}

function matchGlob(rel, pattern) {
  const rx = new RegExp('^' + pattern.split('/').map((seg) => {
    if (seg === '**') return '.*';
    return seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  }).join('/') + '(/|$)');
  return rx.test(rel);
}

function* walk(node, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  yield [node, parent];
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') yield* walk(child, node);
    } else if (value && typeof value.type === 'string') {
      yield* walk(value, node);
    }
  }
}

// ─── 复杂度计算 ──────────────────────────────────────────────────────────────
function complexityOf(fn) {
  let score = 1;
  for (const [node] of walk(fn)) {
    if (DECISION_NODES.has(node.type)) score += 1;
    else if (node.type === 'SwitchCase' && node.test) score += 1;
    else if (node.type === 'LogicalExpression'
        && ['&&', '||', '??'].includes(node.operator)) score += 1;
  }
  return score;
}

function functionName(node, parent) {
  if (node.id && node.id.name) return node.id.name;
  if (!parent) return '(匿名)';
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if ((parent.type === 'MethodDefinition' || parent.type === 'Property') && parent.key) {
    return parent.key.name || parent.key.value || '(匿名)';
  }
  if (parent.type === 'AssignmentExpression' && parent.left.type === 'MemberExpression') {
    return parent.left.property.name || '(匿名)';
  }
  if (parent.type === 'ExportDefaultDeclaration') return '(default)';
  return '(匿名)';
}

function parseCode(text) {
  for (const sourceType of ['module', 'script']) {
    try {
      return espree.parse(text, {
        ecmaVersion: 'latest',
        sourceType,
        ecmaFeatures: { jsx: true },
        loc: true,
      });
    } catch { /* 尝试下一种 sourceType */ }
  }
  return null;
}

// 返回 Map<key, score>，key 形如 `path#name`（同名函数追加 ~2 ~3 区分）
function collectScores(extraIgnores) {
  const rels = [];
  collectFiles(ROOT, '', extraIgnores, rels);
  rels.sort();
  const scores = new Map();
  const parseFailures = [];
  for (const rel of rels) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    const tree = parseCode(text);
    if (!tree) { parseFailures.push(rel); continue; }
    const nameCounts = new Map();
    for (const [node, parent] of walk(tree)) {
      if (!FUNCTION_TYPES.has(node.type)) continue;
      if (parent?.type === 'MethodDefinition' && parent.value !== node) continue;
      const name = functionName(node, parent);
      const occurrence = (nameCounts.get(name) || 0) + 1;
      nameCounts.set(name, occurrence);
      const key = `${rel}#${name}${occurrence > 1 ? `~${occurrence}` : ''}`;
      scores.set(key, complexityOf(node));
    }
  }
  return { scores, parseFailures, fileCount: rels.length };
}

// ─── 基线 ────────────────────────────────────────────────────────────────────
function loadBaseline(absPath) {
  if (!existsSync(absPath)) return { version: BASELINE_VERSION, functions: {} };
  const data = JSON.parse(readFileSync(absPath, 'utf8'));
  if (data.version !== BASELINE_VERSION) {
    throw new Error(`不支持的基线版本: ${data.version}`);
  }
  return data;
}

function writeBaseline(absPath, scores) {
  const functions = {};
  for (const [key, score] of [...scores.entries()].sort()) {
    if (score > LIMIT) functions[key] = score;
  }
  const payload = { version: BASELINE_VERSION, limit: LIMIT, functions };
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { ignores: [], updateBaseline: false, baseline: DEFAULT_BASELINE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--update-baseline') args.updateBaseline = true;
    else if (arg === '--baseline') args.baseline = argv[++i];
    else if (arg === '--ignore') args.ignores.push(argv[++i]);
    else if (arg === '--root') ROOT = path.resolve(argv[++i]);
    else {
      console.error(`✖ 未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselinePath = path.isAbsolute(args.baseline) ? args.baseline : path.join(ROOT, args.baseline);

  let scores, parseFailures, fileCount;
  try {
    ({ scores, parseFailures, fileCount } = collectScores(args.ignores));
  } catch (err) {
    console.error(`✖ 无法扫描仓库: ${err.message}`);
    process.exit(1);
  }

  if (args.updateBaseline) {
    writeBaseline(baselinePath, scores);
    const kept = [...scores.values()].filter((s) => s > LIMIT).length;
    console.log(`[complexity] 基线已更新\nFile: ${path.relative(ROOT, baselinePath)}\n`
      + `函数: ${scores.size}（超标 ${kept} 个写入基线）`);
    process.exit(0);
  }

  let baseline;
  try {
    baseline = loadBaseline(baselinePath);
  } catch (err) {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  }
  const baselineFns = baseline.functions || {};

  const failures = [];

  if (scores.size < MIN_FUNCTION_COUNT) {
    failures.push(`扫到的函数过少（${scores.size} < ${MIN_FUNCTION_COUNT}），遍历逻辑可能坏了`);
  }
  for (const rel of parseFailures) {
    failures.push(`解析失败：${rel}（espree 无法解析，请检查语法）`);
  }

  // 1. 新增超标函数
  const newOffenders = [...scores.entries()]
    .filter(([key, score]) => score > LIMIT && !(key in baselineFns))
    .sort();
  if (newOffenders.length) {
    failures.push(
      `这些函数圈复杂度超过 ${LIMIT}，而且不在基线里：\n`
      + newOffenders.map(([k, v]) => `  ${k}: ${v}`).join('\n')
      + '\n拆成几个有名字的步骤；确实是固有复杂度（多系统对齐那种）就运行 '
      + '`node scripts/check-complexity.mjs --update-baseline` 并在提交说明里给出理由。',
    );
  }

  // 2. 基线只许降不许升
  const grew = Object.entries(baselineFns)
    .filter(([key, base]) => scores.has(key) && scores.get(key) > base)
    .sort();
  if (grew.length) {
    failures.push(
      '基线里的函数又变复杂了（只许降不许升）：\n'
      + grew.map(([k, b]) => `  ${k}: ${b} → ${scores.get(k)}`).join('\n'),
    );
  }

  // 3. 基线不能虚挂：降下来了或函数没了，就改小/删掉条目
  const stale = Object.entries(baselineFns)
    .filter(([key, base]) => !scores.has(key) || scores.get(key) < base)
    .sort();
  if (stale.length) {
    failures.push(
      '基线与现状对不上，运行 `node scripts/check-complexity.mjs --update-baseline` '
      + '把基线改成现在的值（或删掉已消失的函数）：\n'
      + stale.map(([k, b]) => `  ${k}: 记的是 ${b}，实际 ${scores.has(k) ? scores.get(k) : '已不存在'}`).join('\n'),
    );
  }

  if (failures.length) {
    console.error(`\n✖ 圈复杂度守卫未通过（扫描 ${fileCount} 个文件 / ${scores.size} 个函数，阈值 ${LIMIT}）\n`);
    for (const f of failures) console.error(`${f}\n`);
    process.exit(1);
  }

  const overCount = [...scores.values()].filter((s) => s > LIMIT).length;
  console.log(`✓ 圈复杂度守卫通过：${fileCount} 个文件 / ${scores.size} 个函数，`
    + `超标 ${overCount} 个均在基线内且未上涨（阈值 ${LIMIT}）`);
  process.exit(0);
}

main();
