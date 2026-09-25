#!/usr/bin/env node
/**
 * 运行形态守卫：只看代码形状，不标注复杂度、不测耗时
 *
 * 扫描 frontend/src、backend、assistant/server、assistant/client/src 的正式代码（不含测试）。
 * 循环指 for / for-of / for-in / while / do-while 以及 forEach 回调；逐项查询规则另把
 * map / filter / reduce 等数组遍历回调也算作循环体。
 *
 * 直接失败（不进基线）：
 *   循环嵌套达到三层，且最内层循环体引用了外层循环变量。两层不报。
 *
 * 记入 scripts/perf-shape-baseline.json，新增算失败、消失算虚挂：
 *   - 循环体内调用 .prepare(，或对 prepare 出来的 Statement 调用 .get( / .all( / .run(，
 *     或调用从 backend/db/queries/ 导入的查询函数
 *     （一次查出再在内存里匹配不在循环里，不会被报）
 *   - backend/app、backend/routes、backend/services 里 SELECT 语句既没有 WHERE 也没有 LIMIT
 *     （backend/services/import-export.js 除外）
 *
 * 用法：
 *   node scripts/check-perf-shape.mjs [--root <dir>] [--baseline <path>] [--update-baseline]
 *
 * 退出码：0 通过 / 1 存在违规
 */

import path from 'node:path';
import {
  BASELINE_NOTE, baselineFailures, collectCodeFiles, compareSets, finish, isTestPath, loadBaseline,
  parseArgs, parseFiles, patternNames, section, suffixDuplicates, walk, writeBaseline,
} from './guard-common.mjs';

const SCRIPT = 'check-perf-shape.mjs';
const DEFAULT_BASELINE = path.join('scripts', 'perf-shape-baseline.json');
const SCAN_DIRS = ['frontend/src', 'backend', 'assistant/server', 'assistant/client/src'];
const SQL_DIRS = ['backend/app/', 'backend/routes/', 'backend/services/'];
const SQL_EXEMPT = new Set(['backend/services/import-export.js']);
const MAX_LOOP_DEPTH = 3;

const LOOP_STATEMENTS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const STATEMENT_METHODS = new Set(['get', 'all', 'run']);
const ITERATION_METHODS = new Set(['map', 'flatMap', 'filter', 'reduce', 'some', 'every', 'find', 'findIndex']);
const QUERY_DIR = 'backend/db/queries/';

// ─── AST 小工具 ──────────────────────────────────────────────────────────────
function* children(node) {
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') yield child;
    } else if (value && typeof value.type === 'string') {
      yield value;
    }
  }
}

const isMethodCall = (node, names) => node?.type === 'CallExpression'
  && node.callee.type === 'MemberExpression' && !node.callee.computed && names.has(node.callee.property.name);

function isForEach(node) {
  return isMethodCall(node, new Set(['forEach'])) && FUNCTION_TYPES.has(node.arguments[0]?.type);
}

// 循环节点 → { body, vars }；vars 是这一层声明的循环变量
function loopOf(node) {
  if (isForEach(node)) return { body: node.arguments[0], vars: node.arguments[0].params.flatMap((p) => patternNames(p)) };
  if (!LOOP_STATEMENTS.has(node.type)) return null;
  if (node.type === 'ForStatement') {
    const init = node.init?.type === 'AssignmentExpression' ? node.init.left : node.init;
    return { body: node.body, vars: patternNames(init) };
  }
  return { body: node.body, vars: patternNames(node.left) };
}

function functionName(node, parent) {
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if ((parent?.type === 'MethodDefinition' || parent?.type === 'Property') && parent.key) {
    return parent.key.name || parent.key.value || null;
  }
  return null;
}

// 引用到的变量名（排除 a.b 的 b、{ b: 1 } 的 b 这类属性名）
function referencedNames(root) {
  const names = new Set();
  for (const [node, parent] of walk(root)) {
    if (node.type !== 'Identifier') continue;
    if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) continue;
    if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition')
        && parent.key === node && !parent.computed && !parent.shorthand) continue;
    names.add(node.name);
  }
  return names;
}

// 文件里由 .prepare(...) 得到的 Statement 变量名
function statementNames(tree) {
  const names = new Set();
  for (const [node] of walk(tree)) {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier'
        && isMethodCall(node.init, new Set(['prepare']))) names.add(node.id.name);
  }
  return names;
}

// 从 backend/db/queries/ 导入的本地名：names 是具名/默认导入，namespaces 是 import * as
function queryImports(file) {
  const names = new Set();
  const namespaces = new Set();
  for (const node of file.tree.body) {
    if (node.type !== 'ImportDeclaration' || !node.source.value.startsWith('.')) continue;
    const target = path.posix.join(path.posix.dirname(file.rel), node.source.value);
    if (!target.startsWith(QUERY_DIR)) continue;
    for (const spec of node.specifiers) {
      (spec.type === 'ImportNamespaceSpecifier' ? namespaces : names).add(spec.local.name);
    }
  }
  return { names, namespaces };
}

// ─── 规则 ────────────────────────────────────────────────────────────────────
function loopQueryCall(node, { stmtNames, queries }) {
  const { callee } = node;
  if (callee.type === 'Identifier' && queries.names.has(callee.name)) return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier'
      && queries.namespaces.has(callee.object.name)) return `${callee.object.name}.${callee.property.name}`;
  if (isMethodCall(node, new Set(['prepare']))) {
    const obj = node.callee.object;
    return obj.type === 'Identifier' ? `${obj.name}.prepare` : '.prepare';
  }
  if (isMethodCall(node, STATEMENT_METHODS) && node.callee.object.type === 'Identifier'
      && stmtNames.has(node.callee.object.name)) {
    return `${node.callee.object.name}.${node.callee.property.name}`;
  }
  return null;
}

function sqlText(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked ?? '').join(' ${} ');
  return null;
}

function unfilteredSelects(text) {
  return text.split(';')
    .filter((stmt) => /\bSELECT\b[\s\S]*\bFROM\b/i.test(stmt) && !/\b(WHERE|LIMIT)\b/i.test(stmt))
    .map((stmt) => stmt.replace(/\s+/g, ' ').trim().slice(0, 80));
}

function checkDeepLoop(loopNode, body, outerLoops, ctx) {
  const outerVars = new Set(outerLoops.flatMap((l) => l.vars));
  const used = [...referencedNames(body)].filter((n) => outerVars.has(n));
  if (!used.length) return;
  ctx.found.hard.push(`${ctx.file.rel}:${loopNode.loc.start.line} 循环嵌套 ${outerLoops.length + 1} 层，`
    + `最内层引用了外层循环变量 ${used.join(', ')}；先按键建索引再单层遍历`);
}

function inspectNode(node, state, ctx) {
  if ((state.loops.length || state.perItem) && node.type === 'CallExpression') {
    const call = loopQueryCall(node, ctx);
    if (call) ctx.found.loopQueries.push(`${ctx.file.rel}#${state.fn}#${call}`);
  }
  if (!ctx.sqlScope) return;
  const text = sqlText(node);
  if (text) unfilteredSelects(text).forEach((sql) => ctx.found.selects.push(`${ctx.file.rel}#${state.fn}#${sql}`));
}

function visit(node, parent, state, ctx) {
  const next = FUNCTION_TYPES.has(node.type) ? { ...state, fn: functionName(node, parent) ?? state.fn } : state;
  inspectNode(node, next, ctx);
  const loop = loopOf(node);
  const iterator = isMethodCall(node, ITERATION_METHODS) && FUNCTION_TYPES.has(node.arguments[0]?.type)
    ? node.arguments[0] : null;
  for (const child of children(node)) {
    if (child === iterator) {
      visit(child, node, { ...next, perItem: true }, ctx);
      continue;
    }
    if (!loop || child !== loop.body) {
      visit(child, node, next, ctx);
      continue;
    }
    const loops = [...next.loops, { vars: loop.vars }];
    if (loops.length >= MAX_LOOP_DEPTH) checkDeepLoop(node, child, next.loops, ctx);
    visit(child, node, { ...next, loops }, ctx);
  }
}

// ─── 汇总 ────────────────────────────────────────────────────────────────────
function collectPerfShape(root) {
  const rels = SCAN_DIRS.flatMap((dir) => collectCodeFiles(root, dir)).filter((rel) => !isTestPath(rel));
  const { parsed, parseFailures } = parseFiles(root, rels);
  const found = { hard: [], loopQueries: [], selects: [] };
  for (const file of parsed) {
    const sqlScope = SQL_DIRS.some((dir) => file.rel.startsWith(dir)) && !SQL_EXEMPT.has(file.rel);
    const ctx = { file, found, sqlScope, stmtNames: statementNames(file.tree), queries: queryImports(file) };
    visit(file.tree, null, { loops: [], perItem: false, fn: '(顶层)' }, ctx);
  }
  return {
    hard: found.hard,
    loopQueries: suffixDuplicates(found.loopQueries),
    selects: suffixDuplicates(found.selects),
    parseFailures,
    fileCount: rels.length,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2), DEFAULT_BASELINE);
  const shape = collectPerfShape(args.root);
  const summary = `${shape.fileCount} 个文件，循环内查询 ${shape.loopQueries.length} 处、`
    + `无 WHERE/LIMIT 的 SELECT ${shape.selects.length} 处`;

  if (args.updateBaseline && !shape.parseFailures.length) {
    writeBaseline(args.baselinePath, { loopQueries: shape.loopQueries, selectsWithoutFilter: shape.selects });
    console.log(`[perf-shape] 基线已更新\nFile: ${path.relative(args.root, args.baselinePath)}\n${summary}写入基线`);
    process.exit(0);
  }

  const failures = [];
  if (shape.fileCount === 0) failures.push(`没有扫到任何文件（${SCAN_DIRS.join('、')}），遍历逻辑可能坏了`);
  for (const rel of shape.parseFailures) failures.push(`解析失败：${rel}（espree 无法解析，请检查语法）`);
  if (shape.hard.length) failures.push(section('运行形态违规（不进基线，必须改掉）：', shape.hard));

  let baseline;
  try {
    baseline = loadBaseline(args.baselinePath, { loopQueries: [], selectsWithoutFilter: [] });
  } catch (err) {
    finish('运行形态守卫', [err.message], summary);
  }
  failures.push(...baselineFailures(compareSets(shape.loopQueries, baseline.loopQueries || []), {
    script: SCRIPT, addedTitle: '这些查询在循环里逐项执行，而且不在基线里；改成一次查出再在内存里匹配',
  }));
  failures.push(...baselineFailures(compareSets(shape.selects, baseline.selectsWithoutFilter || []), {
    script: SCRIPT, addedTitle: '这些 SELECT 既没有 WHERE 也没有 LIMIT，而且不在基线里；加条件或挪进 backend/db/queries',
  }));

  finish('运行形态守卫', failures, summary, BASELINE_NOTE);
}

main();
