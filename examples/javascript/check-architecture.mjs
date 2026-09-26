#!/usr/bin/env node
/**
 * 架构边界参考守卫：用仓内依赖图检查少量固定的禁止依赖关系。
 *
 * 规则中的目录只是示例。移植到实际仓库时，先确认模块边界，再替换 ARCH_RULES。
 * 默认所有发现都是硬规则；需要容忍存量时显式加 --baseline-mode，沿用现有基线比较。
 *
 * 用法：
 *   node scripts/check-architecture.mjs [--root <dir>]
 *   node scripts/check-architecture.mjs --baseline-mode [--baseline <path>] [--update-baseline]
 *
 * 扫描正式代码，排除测试、依赖、构建产物、coverage、数据和点开头目录。
 * 未知变量式动态 import 不进入静态图；字面量仓内引用无法解析时 detector health 失败。
 */

import path from 'node:path';
import {
  baselineFailures, collectCodeFiles, compareSets, finish, isTestPath, loadBaseline, parseArgs, section, writeBaseline,
} from './guard-common.mjs';
import { buildImportGraph } from './import-graph.mjs';

const SCRIPT = 'check-architecture.mjs';
const DEFAULT_BASELINE = path.join('scripts', 'architecture-baseline.json');

// 只用于说明规则写法；应用到实际仓库前按其真实目录约定替换。
const ARCH_RULES = [
  { rule: 'forbidden-dependency', from: /^frontend\//, to: /^backend\/db\// },
  { rule: 'forbidden-dependency', from: /^backend\/routes\//, to: /^backend\/db\// },
  {
    rule: 'internal-api-import',
    from: /^features\/[^/]+\//,
    to: /^features\/[^/]+\/(?:internal|src|private)\//,
    crossFeature: true,
  },
];

function featureName(rel) {
  const match = /^features\/([^/]+)\//.exec(rel);
  return match?.[1] ?? null;
}

function violates(rule, source, target) {
  if (!rule.from.test(source) || !rule.to.test(target)) return false;
  if (rule.crossFeature && featureName(source) === featureName(target)) return false;
  return true;
}

function collectArchitecture(root) {
  const rels = collectCodeFiles(root).filter((rel) => !isTestPath(rel));
  const graph = buildImportGraph(root, rels);
  const findings = new Map();
  const edges = new Set();
  for (const [source, mod] of graph.modules) {
    for (const { target } of mod.refs) {
      edges.add(`${source} -> ${target}`);
      for (const rule of ARCH_RULES) {
        if (!violates(rule, source, target)) continue;
        const key = `${source} -> ${target}`;
        findings.set(`${rule.rule}:${key}`, { rule: rule.rule, key });
      }
    }
  }
  return {
    sourceFiles: rels.length,
    parsedFiles: graph.parsed.length,
    modules: graph.modules.size,
    resolvedEdges: edges.size,
    unresolvedStaticImports: graph.unresolvedStaticImports,
    parseFailures: graph.parseFailures,
    findings: [...findings.values()].sort((a, b) => {
      const left = `${a.rule}\0${a.key}`;
      const right = `${b.rule}\0${b.key}`;
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  };
}

function healthFailures(scan) {
  const failures = [];
  if (scan.sourceFiles === 0) failures.push('没有扫到任何正式源码文件，扫描范围可能失效');
  if (scan.parsedFiles !== scan.sourceFiles) {
    failures.push(`解析覆盖不完整：计划 ${scan.sourceFiles} 个源码文件，成功解析 ${scan.parsedFiles} 个`);
  }
  if (scan.modules !== scan.parsedFiles) {
    failures.push(`依赖图构建不完整：${scan.parsedFiles} 个已解析文件，仅构建 ${scan.modules} 个模块`);
  }
  for (const rel of scan.parseFailures) failures.push(`解析失败：${rel}（espree 无法解析，请检查语法）`);
  for (const ref of scan.unresolvedStaticImports) {
    failures.push(`无法解析仓内静态引用：${ref.source} -> ${ref.specifier}（目标 ${ref.target}）`);
  }
  return failures;
}

function main() {
  const argv = process.argv.slice(2);
  const baselineMode = argv.includes('--baseline-mode');
  const args = parseArgs(argv.filter((arg) => arg !== '--baseline-mode'), DEFAULT_BASELINE);
  if (args.updateBaseline && !baselineMode) {
    console.error('✖ 硬规则模式不写基线；存量例外请显式使用 --baseline-mode');
    process.exit(2);
  }

  let scan;
  try {
    scan = collectArchitecture(args.root);
  } catch (err) {
    finish('架构边界守卫', [`扫描或构建依赖图失败：${err.message}`], 'detector health 不通过');
  }

  const summary = `${scan.parsedFiles}/${scan.sourceFiles} 个正式源码文件已解析，`
    + `${scan.modules} 个模块 / ${scan.resolvedEdges} 条依赖边，${scan.findings.length} 个架构发现`;
  const health = healthFailures(scan);
  const keys = scan.findings.map(({ rule, key }) => `${rule}:${key}`);

  if (args.updateBaseline) {
    if (health.length) finish('架构边界守卫', ['detector health 不通过', ...health], summary);
    writeBaseline(args.baselinePath, { findings: keys });
    console.log(`[architecture] 基线已更新\nFile: ${path.relative(args.root, args.baselinePath)}\n${summary}`);
    process.exit(0);
  }

  const failures = [...health];
  if (baselineMode) {
    let baseline;
    try {
      baseline = loadBaseline(args.baselinePath, { findings: [] });
    } catch (err) {
      finish('架构边界守卫', [err.message], summary);
    }
    failures.push(...baselineFailures(compareSets(keys, baseline.findings || []), {
      script: `${SCRIPT} --baseline-mode`,
      addedTitle: '新增架构边界违规；修正依赖方向，或确认存量后更新基线',
    }));
  } else if (scan.findings.length) {
    failures.push(section('架构边界违规（硬规则，必须修正）：',
      scan.findings.map(({ rule, key }) => `${rule}: ${key}`)));
  }

  finish('架构边界守卫', failures, summary);
}

main();
