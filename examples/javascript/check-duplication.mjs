#!/usr/bin/env node
/**
 * 重复代码守卫：连续语句的 token 序列不许新增复制
 *
 * 比较单位是同一语句列表（文件顶层、代码块、case 分支）里连续的可执行语句。
 * 比较前把标识符名字统一抹掉，空白和注释本来就不进 token，所以改名后复制
 * 过来的代码也算重复；字面量、关键字、运算符保持原样。
 * 片段短于 MIN_TOKENS 不报；被更大重复片段包住的小片段不重复报。
 *
 * 现有重复按规范化指纹写进 scripts/duplication-baseline.json：
 *   - 新指纹、或已有指纹多出一处复制 → 失败
 *   - 指纹消失或复制处变少 → 虚挂，必须 --update-baseline 清掉
 * 故意保留的平行实现只能通过 --update-baseline 留下，并在提交说明里写理由。
 *
 * 用法：
 *   node scripts/check-duplication.mjs [--root <dir>] [--baseline <path>] [--update-baseline]
 *
 * 退出码：0 通过 / 1 存在违规
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  BASELINE_NOTE, baselineFailures, collectCodeFiles, compareCounts, finish, isTestPath, loadBaseline,
  parseArgs, parseFiles, walk, writeBaseline,
} from './guard-common.mjs';

const SCRIPT = 'check-duplication.mjs';
const DEFAULT_BASELINE = path.join('scripts', 'duplication-baseline.json');
const SCAN_DIRS = ['frontend/src', 'backend', 'assistant/server', 'assistant/client/src'];
const MIN_TOKENS = 40;

const IDENTIFIER_TOKENS = new Set(['Identifier', 'JSXIdentifier', 'PrivateIdentifier']);
const STATEMENT_LISTS = { Program: 'body', BlockStatement: 'body', StaticBlock: 'body', SwitchCase: 'consequent' };

// ─── 规范化 ──────────────────────────────────────────────────────────────────
function normalizeTokens(tokens) {
  const out = [];
  for (const tok of tokens) {
    if (IDENTIFIER_TOKENS.has(tok.type)) out.push({ start: tok.range[0], value: '$' });
    else if (tok.type === 'JSXText') {
      const text = tok.value.replace(/\s+/g, ' ').trim();
      if (text) out.push({ start: tok.range[0], value: text });
    } else out.push({ start: tok.range[0], value: tok.value });
  }
  return out;
}

function lowerBound(tokens, pos) {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function isExecutable(stmt) {
  if (stmt.type === 'ImportDeclaration' || stmt.type === 'ExportAllDeclaration') return false;
  if (stmt.type === 'ExportNamedDeclaration') return Boolean(stmt.declaration);
  return true;
}

// 把一个文件拆成若干「连续可执行语句」序列，每条语句带规范化 token 文本
function statementRuns(file, tokens) {
  const runs = [];
  for (const [node] of walk(file.tree)) {
    const key = STATEMENT_LISTS[node.type];
    if (!key) continue;
    let run = [];
    for (const stmt of node[key]) {
      if (!isExecutable(stmt)) {
        if (run.length) runs.push(run);
        run = [];
        continue;
      }
      const from = lowerBound(tokens, stmt.range[0]);
      const to = lowerBound(tokens, stmt.range[1]);
      run.push({
        rel: file.rel,
        text: tokens.slice(from, to).map((t) => t.value).join(' '),
        count: to - from,
        range: stmt.range,
        startLine: stmt.loc.start.line,
        endLine: stmt.loc.end.line,
      });
    }
    if (run.length) runs.push(run);
  }
  return runs;
}

// ─── 找重复 ──────────────────────────────────────────────────────────────────
function indexStatements(runs) {
  const ids = new Map();
  const occurrences = new Map();
  runs.forEach((run, r) => run.forEach((stmt, p) => {
    if (!ids.has(stmt.text)) ids.set(stmt.text, ids.size);
    stmt.id = ids.get(stmt.text);
    if (!occurrences.has(stmt.id)) occurrences.set(stmt.id, []);
    occurrences.get(stmt.id).push([r, p]);
  }));
  return occurrences;
}

// 从一对相同语句出发向后扩展；左侧还能对齐的不是起点，交给更早的那一对
function extendPair(runs, [ra, pa], [rb, pb]) {
  const a = runs[ra];
  const b = runs[rb];
  if (pa > 0 && pb > 0 && a[pa - 1].id === b[pb - 1].id) return null;
  let len = 0;
  let tokens = 0;
  while (pa + len < a.length && pb + len < b.length && a[pa + len].id === b[pb + len].id) {
    if (ra === rb && pa + len >= pb) break;
    tokens += a[pa + len].count;
    len += 1;
  }
  if (tokens < MIN_TOKENS) return null;
  return { tokens, first: a.slice(pa, pa + len), second: b.slice(pb, pb + len) };
}

function occurrenceOf(stmts) {
  const first = stmts[0];
  const last = stmts[stmts.length - 1];
  return {
    rel: first.rel,
    range: [first.range[0], last.range[1]],
    location: `${first.rel}:${first.startLine}-${last.endLine}`,
  };
}

function findClones(runs) {
  const groups = new Map();
  for (const list of indexStatements(runs).values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const clone = extendPair(runs, list[i], list[j]);
        if (clone) addClone(groups, clone);
      }
    }
  }
  return dropContained(groups);
}

function addClone(groups, { tokens, first, second }) {
  const fingerprint = createHash('sha1')
    .update(first.map((s) => s.text).join(' ')).digest('hex').slice(0, 16);
  if (!groups.has(fingerprint)) groups.set(fingerprint, { tokens, occurrences: new Map() });
  const group = groups.get(fingerprint);
  for (const occ of [occurrenceOf(first), occurrenceOf(second)]) group.occurrences.set(occ.location, occ);
}

// 每处出现都落在别的更大重复片段里面的组不单独报
function dropContained(groups) {
  const byFile = new Map();
  for (const group of groups.values()) {
    for (const occ of group.occurrences.values()) {
      if (!byFile.has(occ.rel)) byFile.set(occ.rel, []);
      byFile.get(occ.rel).push(occ);
    }
  }
  const covered = (occ) => byFile.get(occ.rel).some((o) => o !== occ
    && o.range[0] <= occ.range[0] && o.range[1] >= occ.range[1]
    && o.range[1] - o.range[0] > occ.range[1] - occ.range[0]);
  const result = {};
  for (const [fingerprint, group] of [...groups.entries()].sort()) {
    const occs = [...group.occurrences.values()];
    if (occs.every(covered)) continue;
    result[fingerprint] = { tokens: group.tokens, locations: occs.map((o) => o.location).sort() };
  }
  return result;
}

function collectDuplicates(root) {
  const rels = SCAN_DIRS.flatMap((dir) => collectCodeFiles(root, dir)).filter((rel) => !isTestPath(rel));
  const { parsed, parseFailures } = parseFiles(root, rels, { tokens: true });
  const runs = parsed.flatMap((file) => statementRuns(file, normalizeTokens(file.tree.tokens)));
  return { duplicates: findClones(runs), parseFailures, fileCount: rels.length };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2), DEFAULT_BASELINE);
  const { duplicates, parseFailures, fileCount } = collectDuplicates(args.root);
  const groupCount = Object.keys(duplicates).length;

  if (args.updateBaseline && !parseFailures.length) {
    writeBaseline(args.baselinePath, { minTokens: MIN_TOKENS, duplicates });
    console.log(`[duplication] 基线已更新\nFile: ${path.relative(args.root, args.baselinePath)}\n`
      + `文件: ${fileCount}（重复 ${groupCount} 段写入基线）`);
    process.exit(0);
  }

  const failures = [];
  if (fileCount === 0) failures.push(`没有扫到任何文件（${SCAN_DIRS.join('、')}），遍历逻辑可能坏了`);
  for (const rel of parseFailures) failures.push(`解析失败：${rel}（espree 无法解析，请检查语法）`);

  let baseline;
  try {
    baseline = loadBaseline(args.baselinePath, { duplicates: {} });
  } catch (err) {
    finish('重复代码守卫', [err.message], `扫描 ${fileCount} 个文件`);
  }
  const current = Object.fromEntries(Object.entries(duplicates).map(([k, v]) => [k, v.locations.length]));
  const recorded = Object.fromEntries(Object.entries(baseline.duplicates || {})
    .map(([k, v]) => [k, v.locations.length]));
  const describe = (key) => `${key}（${duplicates[key].tokens} token）：${duplicates[key].locations.join('、')}`;
  failures.push(...baselineFailures(compareCounts(current, recorded, { describe }), {
    script: SCRIPT,
    addedTitle: `这些连续语句重复了（≥ ${MIN_TOKENS} token），而且不在基线里；抽成共用函数`,
  }));

  finish('重复代码守卫', failures, `${fileCount} 个文件，重复 ${groupCount} 段（门槛 ${MIN_TOKENS} token）`, BASELINE_NOTE);
}

main();
