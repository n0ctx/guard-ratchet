/**
 * 仓库内模块引用关系图，供 check-dead-code / check-cycles 使用
 *
 * 引用来源：import / export from、require('…')、import('…') 的字符串字面量（含 React.lazy），
 * 以及测试辅助 freshImport('仓库根相对路径')。相对路径解析到实际文件
 * （补 .js/.jsx/.mjs/.cjs，目录补 index）；import(变量) 不猜。
 */

import path from 'node:path';
import { CODE_SUFFIXES, parseFiles, patternNames, stringValue, walk } from './guard-common.mjs';

export const ALL = '*';
// backend/tests/helpers/test-env.js 里按仓库根相对路径动态加载模块的函数
const ROOT_IMPORTERS = new Set(['freshImport', 'freshImportUncached']);

export function resolveFile(fileSet, base) {
  const clean = path.posix.normalize(base.replace(/[?#].*$/, ''));
  if (clean.startsWith('../')) return null;
  const suffixes = [...CODE_SUFFIXES];
  const candidates = [clean, ...suffixes.map((s) => clean + s), ...suffixes.map((s) => `${clean}/index${s}`)];
  return candidates.find((c) => fileSet.has(c)) ?? null;
}

const moduleName = (node) => node.name ?? node.value;

function declarationNames(decl) {
  if (decl.type === 'VariableDeclaration') return decl.declarations.flatMap((d) => patternNames(d.id));
  return decl.id ? [decl.id.name] : [];
}

function importNames(node) {
  return node.specifiers.map((s) => {
    if (s.type === 'ImportDefaultSpecifier') return 'default';
    if (s.type === 'ImportNamespaceSpecifier') return ALL;
    return moduleName(s.imported);
  });
}

const relative = (rel, spec) => (typeof spec === 'string' && spec.startsWith('.')
  ? path.posix.join(path.posix.dirname(rel), spec) : null);

// 返回 { refs: [{ base, names, lazy }], exports: 名字[] }；base 是待解析的仓库相对路径，
// lazy 表示运行到这里才加载（import() / freshImport），不构成加载期的循环
function moduleShape(rel, tree) {
  const refs = [];
  const exports = [];
  const ref = (base, names, lazy = false) => refs.push({ base, names, lazy });
  for (const [node] of walk(tree)) {
    if (node.type === 'ImportDeclaration') ref(relative(rel, node.source.value), importNames(node));
    else if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) exports.push(...declarationNames(node.declaration));
      exports.push(...node.specifiers.map((s) => moduleName(s.exported)));
      if (node.source) ref(relative(rel, node.source.value), node.specifiers.map((s) => moduleName(s.local)));
    } else if (node.type === 'ExportAllDeclaration') {
      ref(relative(rel, node.source.value), [ALL]);
      if (node.exported) exports.push(moduleName(node.exported));
    } else if (node.type === 'ExportDefaultDeclaration') exports.push('default');
    else if (node.type === 'ImportExpression') ref(relative(rel, stringValue(node.source)), [ALL], true);
    else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.arguments.length === 1) {
      if (node.callee.name === 'require') ref(relative(rel, stringValue(node.arguments[0])), [ALL]);
      else if (ROOT_IMPORTERS.has(node.callee.name)) ref(stringValue(node.arguments[0]), [ALL], true);
    }
  }
  return { refs, exports };
}

// 返回 { fileSet, parseFailures, modules: Map<rel, { exports, refs: [{ target, names, lazy }] }> }
export function buildImportGraph(root, rels) {
  const fileSet = new Set(rels);
  const { parsed, parseFailures } = parseFiles(root, rels);
  const modules = new Map();
  for (const { rel, tree } of parsed) {
    const { refs, exports } = moduleShape(rel, tree);
    const resolved = refs
      .map(({ base, names, lazy }) => ({ target: base && resolveFile(fileSet, base), names, lazy }))
      .filter(({ target }) => target && target !== rel);
    modules.set(rel, { exports: [...new Set(exports)], refs: resolved });
  }
  return { fileSet, parseFailures, modules };
}
