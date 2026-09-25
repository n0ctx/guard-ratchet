/**
 * 源码守卫公共部分：仓库遍历、espree 解析、命令行参数、基线读写
 *
 * 供 check-duplication / check-dead-code / check-tests / check-perf-shape 使用，
 * 扫描规则与 check-complexity.mjs 一致：跳过依赖/产物/数据目录和点开头的目录。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const espree = require('espree');

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_VERSION = 1;
export const BASELINE_NOTE = '，基线外无新增';

export const CODE_SUFFIXES = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'coverage', 'build', 'test-results', 'data', 'node-runtime',
]);

export function isTestPath(rel) {
  return /(^|\/)(tests|__tests__)\//.test(rel) || /\.(test|spec)\.[^./]+$/.test(rel);
}

const isCodeFile = (name) => CODE_SUFFIXES.has(path.extname(name).toLowerCase());

// 返回 root 下 relDir 内文件名满足 accept 的文件（相对 root，`/` 分隔，已排序）；relDir 不存在时返回空
export function collectFiles(root, relDir = '', accept = isCodeFile) {
  const out = [];
  const start = path.join(root, relDir);
  if (existsSync(start)) walkDir(start, relDir, accept, out);
  return out.sort();
}

export function collectCodeFiles(root, relDir = '') {
  return collectFiles(root, relDir, isCodeFile);
}

function walkDir(dir, relPrefix, accept, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      walkDir(path.join(dir, entry.name), rel, accept, out);
    } else if (entry.isFile() && accept(entry.name)) {
      out.push(rel);
    }
  }
}

export function parseCode(text, { tokens = false } = {}) {
  for (const sourceType of ['module', 'script']) {
    try {
      return espree.parse(text, {
        ecmaVersion: 'latest',
        sourceType,
        ecmaFeatures: { jsx: true },
        loc: true,
        range: true,
        tokens,
      });
    } catch { /* 尝试下一种 sourceType */ }
  }
  return null;
}

// 读取并解析一批文件；解析失败的相对路径放进 parseFailures
export function parseFiles(root, rels, options) {
  const parsed = [];
  const parseFailures = [];
  for (const rel of rels) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    const tree = parseCode(text, options);
    if (tree) parsed.push({ rel, text, tree });
    else parseFailures.push(rel);
  }
  return { parsed, parseFailures };
}

export function* walk(node, parent = null) {
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

export function patternNames(pattern, out = []) {
  if (!pattern) return out;
  if (pattern.type === 'Identifier') out.push(pattern.name);
  else if (pattern.type === 'VariableDeclaration') pattern.declarations.forEach((d) => patternNames(d.id, out));
  else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((p) => patternNames(p.value ?? p.argument, out));
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((e) => patternNames(e, out));
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, out);
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, out);
  return out;
}

export function stringValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

// ─── CLI 与基线 ───────────────────────────────────────────────────────────────
export function parseArgs(argv, defaultBaseline) {
  const args = { root: REPO_ROOT, baseline: defaultBaseline, updateBaseline: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--update-baseline') args.updateBaseline = true;
    else if (arg === '--baseline') args.baseline = argv[++i];
    else if (arg === '--root') args.root = path.resolve(argv[++i]);
    else {
      console.error(`✖ 未知参数: ${arg}`);
      process.exit(2);
    }
  }
  if (args.baseline) {
    args.baselinePath = path.isAbsolute(args.baseline) ? args.baseline : path.join(args.root, args.baseline);
  }
  return args;
}

export function loadBaseline(absPath, empty) {
  if (!existsSync(absPath)) return { version: BASELINE_VERSION, ...empty };
  const data = JSON.parse(readFileSync(absPath, 'utf8'));
  if (data.version !== BASELINE_VERSION) throw new Error(`不支持的基线版本: ${data.version}`);
  return data;
}

export function writeBaseline(absPath, payload) {
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify({ version: BASELINE_VERSION, ...payload }, null, 2) + '\n', 'utf8');
}

// 计数型基线对比：current / baseline 都是 { key: count }，只登记 count > allowed 的条目；
// describe(key) 可给新增条目附加说明
export function compareCounts(current, baseline, { allowed = 0, describe = (key) => `${key}: ${current[key]}` } = {}) {
  const added = [];
  const grew = [];
  const stale = [];
  for (const [key, count] of Object.entries(current)) {
    if (count <= allowed) continue;
    if (!(key in baseline)) added.push(describe(key));
    else if (count > baseline[key]) grew.push(`${key}: ${baseline[key]} → ${count}`);
  }
  for (const [key, base] of Object.entries(baseline)) {
    const count = current[key] ?? 0;
    if (count < base) stale.push(`${key}: 记的是 ${base}，实际 ${count}`);
  }
  return { added: added.sort(), grew: grew.sort(), stale: stale.sort() };
}

// 集合型基线对比：只看条目有没有
export function compareSets(current, baseline) {
  const now = new Set(current);
  const recorded = new Set(baseline);
  return {
    added: [...now].filter((key) => !recorded.has(key)).sort(),
    stale: [...recorded].filter((key) => !now.has(key)).sort(),
  };
}

// 同一 key 第二次起追加 ~2 ~3 区分，返回排序后的列表
export function suffixDuplicates(keys) {
  const seen = new Map();
  return keys.map((key) => {
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return n > 1 ? `${key} ~${n}` : key;
  }).sort();
}

// 把 key 列表转成 { key: 出现次数 }
export function countKeys(keys) {
  const counts = {};
  for (const key of keys) counts[key] = (counts[key] || 0) + 1;
  return counts;
}

// passNote 只在通过时附在摘要后面
export function finish(label, failures, summary, passNote = '') {
  if (failures.length) {
    console.error(`\n✖ ${label}未通过（${summary}）\n`);
    for (const f of failures) console.error(`${f}\n`);
    process.exit(1);
  }
  console.log(`✓ ${label}通过：${summary}${passNote}`);
  process.exit(0);
}

export function section(title, lines) {
  return `${title}\n${lines.map((l) => `  ${l}`).join('\n')}`;
}

// 统一处理「新增 / 上涨 / 虚挂」三类基线差异
export function baselineFailures(diff, { script, addedTitle }) {
  const failures = [];
  const update = `\`node scripts/${script} --update-baseline\``;
  if (diff.added.length) {
    failures.push(section(`${addedTitle}（故意保留就运行 ${update} 并在提交说明里写理由）：`, diff.added));
  }
  if (diff.grew?.length) failures.push(section('基线里的条目又变多了（只许降不许升）：', diff.grew));
  if (diff.stale.length) {
    failures.push(section(`基线与现状对不上（已改善或已消失），运行 ${update} 清掉：`, diff.stale));
  }
  return failures;
}
