#!/usr/bin/env node
/**
 * 死代码守卫：没人引用的文件、没人引用的 export 不许新增
 *
 * 只看两样：
 *   1. 没有任何其他文件静态引用的文件；
 *   2. export 了但没有任何其他文件引用的名字。
 * 函数内部没用到的变量交给 ESLint，这里不管。
 *
 * 引用的认定见 import-graph.mjs。测试文件里的引用算在用；测试文件本身和下列入口不报：
 *   frontend/src/main.jsx、frontend/index.html 引用的脚本、backend/server.js、
 *   各 package.json 的 main / bin / scripts 里出现的仓库内文件、hooks/*.js（hook-loader 按目录加载）、
 *   *.config.{js,mjs,cjs}（eslint / vite / vitest 按文件名约定加载），以及 CONVENTION_ENTRIES 里
 *   按路径字符串加载或供复制的文件。
 * PUBLIC_API 里的文件是对外约定的出口，只要文件本身被引用，其导出就不逐个报。
 * 其余有意保留的导出用 `// guard-allow(dead-code): 理由` 标在 export 旁边，规则见 guard-common.mjs。
 *
 * 现状写进 scripts/dead-code-baseline.json：新增算失败，基线里已不存在的条目算虚挂。
 *
 * 用法：
 *   node scripts/check-dead-code.mjs [--root <dir>] [--baseline <path>] [--update-baseline]
 *
 * 退出码：0 通过 / 1 存在违规
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BASELINE_NOTE, allowFailures, baselineFailures, collectAllowMarkers, collectCodeFiles, collectFiles, compareSets, finish, isTestPath,
  loadBaseline, parseArgs, writeBaseline,
} from './guard-common.mjs';
import { ALL, buildImportGraph, resolveFile } from './import-graph.mjs';

const SCRIPT = 'check-dead-code.mjs';
const DEFAULT_BASELINE = path.join('scripts', 'dead-code-baseline.json');
const ENTRY_FILES = ['frontend/src/main.jsx', 'backend/server.js'];
const HTML_ENTRIES = ['frontend/index.html'];
const HOOK_FILE_RE = /^hooks\/[^/]+\.js$/;
const CONFIG_FILE_RE = /(^|\/)[^/]+\.config\.(js|mjs|cjs)$/;
// 不经 import 加载的入口：Electron 按路径加载 preload；hook 示例与 shell 模板供复制，不被引用
const CONVENTION_ENTRIES = [
  /^desktop\/src\/preload\.js$/,
  /^hooks\/examples\/[^/]+\.js$/,
  /^frontend\/src\/shells\/template\//,
];
// 对外约定的出口：组件库统一出口、写卡助手唯一接入点（见 CLAUDE.md）、各 shell 包的入口
const PUBLIC_API = [
  /^frontend\/src\/components\/index\.js$/,
  /^frontend\/src\/core\/features\/assistant\/index\.js$/,
  /^frontend\/src\/shells\/[^/]+\/index\.js$/,
];

// ─── 入口 ────────────────────────────────────────────────────────────────────
function packageEntries(root, fileSet) {
  const entries = [];
  for (const rel of collectFiles(root, '', (name) => name === 'package.json')) {
    const dir = path.posix.dirname(rel);
    const pkg = JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
    const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {});
    const words = Object.values(pkg.scripts || {})
      .flatMap((cmd) => cmd.split(/\s+/))
      .map((w) => w.replace(/^['"]|['"]$/g, ''))
      .filter((w) => w && !w.startsWith('-'));
    for (const target of [pkg.main, ...bins, ...words]) {
      if (typeof target !== 'string') continue;
      const hit = resolveFile(fileSet, path.posix.join(dir, target));
      if (hit) entries.push(hit);
    }
  }
  return entries;
}

function htmlEntries(root, fileSet) {
  const entries = [];
  for (const rel of HTML_ENTRIES) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    const dir = path.posix.dirname(rel);
    for (const [, src] of readFileSync(abs, 'utf8').matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) {
      const hit = resolveFile(fileSet, path.posix.join(dir, src.replace(/^\//, '')));
      if (hit) entries.push(hit);
    }
  }
  return entries;
}

function collectEntries(root, rels, fileSet) {
  return new Set([
    ...ENTRY_FILES.filter((rel) => fileSet.has(rel)),
    ...htmlEntries(root, fileSet),
    ...packageEntries(root, fileSet),
    ...rels.filter((rel) => HOOK_FILE_RE.test(rel) || CONFIG_FILE_RE.test(rel) || isTestPath(rel)
      || CONVENTION_ENTRIES.some((re) => re.test(rel))),
  ]);
}

// ─── 汇总 ────────────────────────────────────────────────────────────────────
function collectDeadCode(root) {
  const rels = collectCodeFiles(root);
  const { fileSet, parsed, parseFailures, modules } = buildImportGraph(root, rels);
  const allow = collectAllowMarkers(parsed, 'dead-code');
  const referencedBy = new Map();
  const usedNames = new Map();
  for (const [rel, { refs }] of modules) {
    for (const { target, names } of refs) {
      if (!referencedBy.has(target)) referencedBy.set(target, new Set());
      referencedBy.get(target).add(rel);
      if (!usedNames.has(target)) usedNames.set(target, new Set());
      names.forEach((n) => usedNames.get(target).add(n));
    }
  }

  const entries = collectEntries(root, rels, fileSet);
  const files = rels.filter((rel) => !entries.has(rel) && !referencedBy.has(rel));
  const exports = [];
  for (const [rel, { exports: declared }] of modules) {
    if (entries.has(rel) || !referencedBy.has(rel) || PUBLIC_API.some((re) => re.test(rel))) continue;
    const used = usedNames.get(rel);
    if (used.has(ALL)) continue;
    exports.push(...declared
      .filter(({ name, line }) => !used.has(name) && !allow.covers(rel, line))
      .map(({ name }) => `${rel}#${name}`));
  }
  return { files, exports: exports.sort(), allow, parseFailures, fileCount: rels.length };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2), DEFAULT_BASELINE);
  const { files, exports, allow, parseFailures, fileCount } = collectDeadCode(args.root);

  if (args.updateBaseline && !parseFailures.length) {
    writeBaseline(args.baselinePath, { files, exports });
    console.log(`[dead-code] 基线已更新\nFile: ${path.relative(args.root, args.baselinePath)}\n`
      + `文件: ${fileCount}（无引用文件 ${files.length} 个、无引用导出 ${exports.length} 个写入基线）`);
    process.exit(0);
  }

  const failures = [];
  if (fileCount === 0) failures.push('没有扫到任何文件，遍历逻辑可能坏了');
  for (const rel of parseFailures) failures.push(`解析失败：${rel}（espree 无法解析，请检查语法）`);

  let baseline;
  try {
    baseline = loadBaseline(args.baselinePath, { files: [], exports: [] });
  } catch (err) {
    finish('死代码守卫', [err.message], `扫描 ${fileCount} 个文件`);
  }
  failures.push(...baselineFailures(compareSets(files, baseline.files || []), {
    script: SCRIPT, addedTitle: '这些文件没有任何其他文件引用，而且不在基线里；删掉或接上引用',
  }));
  failures.push(...baselineFailures(compareSets(exports, baseline.exports || []), {
    script: SCRIPT, addedTitle: '这些导出没有任何其他文件引用，而且不在基线里；删掉 export 或删掉定义',
  }));
  failures.push(...allowFailures(allow));

  finish('死代码守卫', failures,
    `${fileCount} 个文件，无引用文件 ${files.length} 个、无引用导出 ${exports.length} 个`, BASELINE_NOTE, allow.listing());
}

main();
