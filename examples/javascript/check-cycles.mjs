#!/usr/bin/env node
/**
 * 循环依赖守卫：正式代码之间不许出现加载期的循环引用
 *
 * 扫描全仓库正式代码（不含测试）。边取 import / export from / require；import() 是运行到
 * 才加载，不构成加载期循环，不算边。引入时仓库里没有循环，所以不设基线，出现即失败。
 *
 * 用法：
 *   node scripts/check-cycles.mjs [--root <dir>]
 *
 * 退出码：0 通过 / 1 存在循环或解析失败
 */

import { collectCodeFiles, finish, isTestPath, parseArgs, section } from './guard-common.mjs';
import { buildImportGraph } from './import-graph.mjs';

// Tarjan 强连通分量：返回成员数 > 1 的分量（即循环），各分量内按路径排序
function findCycles(edges) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  const connect = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) || []) {
      if (!index.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) !== index.get(v)) return;
    const members = [];
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      members.push(w);
    } while (w !== v);
    if (members.length > 1) cycles.push(members.sort());
  };
  for (const v of edges.keys()) if (!index.has(v)) connect(v);
  return cycles.sort();
}

function main() {
  const args = parseArgs(process.argv.slice(2), null);
  const rels = collectCodeFiles(args.root).filter((rel) => !isTestPath(rel));
  const { parseFailures, modules } = buildImportGraph(args.root, rels);
  const edges = new Map([...modules].map(([rel, { refs }]) => [
    rel, [...new Set(refs.filter((r) => !r.lazy).map((r) => r.target))],
  ]));
  const cycles = findCycles(edges);

  const failures = [];
  if (rels.length === 0) failures.push('没有扫到任何文件，遍历逻辑可能坏了');
  for (const rel of parseFailures) failures.push(`解析失败：${rel}（espree 无法解析，请检查语法）`);
  if (cycles.length) {
    failures.push(section('这些模块互相引用成环；把共用部分抽到下层模块，或改成 import() 按需加载：',
      cycles.map((c) => c.join(' ↔ '))));
  }
  finish('循环依赖守卫', failures, `${rels.length} 个文件，循环 ${cycles.length} 组`);
}

main();
