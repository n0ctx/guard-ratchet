/**
 * 源码守卫公共部分：仓库遍历、espree 解析、命令行参数、基线读写、有意保留标记
 *
 * 供 check-duplication / check-dead-code / check-tests / check-perf-shape 使用，
 * 扫描规则与 check-complexity.mjs 一致：跳过依赖/产物/数据目录和点开头的目录。
 *
 * 有意保留标记：检测器分不清、但确实是有意为之的写法，在代码旁边写
 *   // guard-allow(<守卫名>): <理由>
 * 标记单独占一行，覆盖紧随其后的那条语句，以及与它紧挨着、中间没有空行的后续同级语句。被覆盖的发现不进基线；标记跟着代码走，搬家改名不失效。
 * 没写理由、守卫名写错、覆盖范围里已经没有违规的标记都算失败；每次运行都列出全部标记。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const espree = require('espree');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_VERSION = 1;
export const BASELINE_NOTE = '，基线外无新增';

export const CODE_SUFFIXES = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'generated', 'dist', 'coverage', 'build', 'test-results', 'data', 'node-runtime',
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

function parseCode(text, { tokens = false } = {}) {
  for (const sourceType of ['module', 'script']) {
    try {
      return espree.parse(text, {
        ecmaVersion: 'latest',
        sourceType,
        ecmaFeatures: { jsx: true },
        loc: true,
        range: true,
        tokens,
        comment: true,
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

// comments / tokens 是解析器附带的注释与 token 列表，不是语法树节点
const SKIP_KEYS = new Set(['loc', 'range', 'parent', 'comments', 'tokens']);

export function* walk(node, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  yield [node, parent];
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
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

// passNote 只在通过时附在摘要后面；allowed 是有意保留标记清单，通过与否都列出
export function finish(label, failures, summary, passNote = '', allowed = []) {
  const listing = allowed.length ? `${section(`有意保留（guard-allow）${allowed.length} 处：`, allowed)}\n` : '';
  if (failures.length) {
    console.error(`\n✖ ${label}未通过（${summary}）\n`);
    for (const f of failures) console.error(`${f}\n`);
    if (listing) console.error(listing);
    process.exit(1);
  }
  console.log(`✓ ${label}通过：${summary}${passNote}`);
  if (listing) console.log(listing);
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

// ─── 有意保留标记 ─────────────────────────────────────────────────────────────
const ALLOW_GUARDS = ['dead-code', 'duplication', 'perf-shape', 'tests'];
const ALLOW_RE = /^\s*\*?\s*guard-allow\(([^)]*)\)\s*(?::\s*(.*?))?\s*$/s;

// 每行开头最大的语句/表达式节点，连同它所在的同级列表
function lineStarts(tree) {
  const byLine = new Map();
  for (const [node, parent] of walk(tree)) {
    if (node === tree || !node.loc) continue;
    const line = node.loc.start.line;
    const size = node.range[1] - node.range[0];
    const prev = byLine.get(line);
    if (!prev || size > prev.size) byLine.set(line, { node, parent, size });
  }
  return byLine;
}

function siblingsOf(node, parent) {
  if (!parent) return null;
  for (const value of Object.values(parent)) {
    if (Array.isArray(value) && value.includes(node)) return value;
  }
  return null;
}

// 标记覆盖的行区间 [start, end]：起始节点 + 后面紧挨着（中间没有空行）的同级节点
function coverage(tree, comment, byLine) {
  let line = comment.loc.end.line + 1;
  while (line <= tree.loc.end.line && !byLine.has(line)) line += 1;
  const hit = byLine.get(line);
  if (!hit) return null;
  let end = hit.node.loc.end.line;
  const siblings = siblingsOf(hit.node, hit.parent) ?? [];
  for (const next of siblings.slice(siblings.indexOf(hit.node) + 1)) {
    if (next.loc.start.line !== end + 1) break;
    end = next.loc.end.line;
  }
  return [line, end];
}

class AllowMarkers {
  constructor(guard, markers, malformed) {
    this.guard = guard;
    this.markers = markers;
    this.malformed = malformed;
  }

  // 某处发现是否被标记覆盖；覆盖到的标记记为用过
  covers(rel, line) {
    const hits = this.markers.filter((m) => m.rel === rel && line >= m.range[0] && line <= m.range[1]);
    hits.forEach((m) => { m.used = true; });
    return hits.length > 0;
  }

  // 检测跑完后调用：没写理由 / 守卫名写错 / 覆盖范围里已无违规的标记
  problems() {
    const stale = this.markers.filter((m) => !m.used)
      .map((m) => `${m.where} 覆盖的代码里已经没有 ${this.guard} 违规，删掉这个标记`);
    return [...this.malformed, ...stale];
  }

  listing() {
    return this.markers.map((m) => `${m.where} ${m.reason}`);
  }
}

/** 收集 guard 这个守卫在 parsed 文件里的标记，返回 AllowMarkers */
export function collectAllowMarkers(parsed, guard) {
  const markers = [];
  const malformed = [];
  for (const file of parsed) {
    const byLine = lineStarts(file.tree);
    for (const comment of file.tree.comments || []) {
      const match = ALLOW_RE.exec(comment.value);
      if (!match) continue;
      const where = `${file.rel}:${comment.loc.start.line}`;
      const name = match[1].trim();
      const reason = (match[2] ?? '').trim();
      const range = coverage(file.tree, comment, byLine);
      if (!ALLOW_GUARDS.includes(name)) malformed.push(`${where} 守卫名 \`${name}\` 不存在（可用：${ALLOW_GUARDS.join('、')}）`);
      else if (name !== guard) continue;
      else if (!reason) malformed.push(`${where} 标记没写理由：写成 \`guard-allow(${name}): 为什么这里是有意的\``);
      else if (!range) malformed.push(`${where} 标记后面没有代码可覆盖`);
      else markers.push({ rel: file.rel, where, reason, range, used: false });
    }
  }
  return new AllowMarkers(guard, markers, malformed);
}

// 标记问题并入失败列表
export function allowFailures(allow) {
  const problems = allow.problems();
  return problems.length ? [section('有意保留标记有问题（guard-allow）：', problems)] : [];
}
