/**
 * 仓库内模块引用关系图，供 check-dead-code / check-cycles 使用
 *
 * 引用来源：import / export from、require('…')、import('…') 的字符串字面量（含 React.lazy），
 * 以及测试辅助 freshImport('仓库根相对路径')。相对路径解析到实际文件
 * （补 .js/.jsx/.mjs/.cjs，目录补 index）。import() 的参数是表达式时，只认其中
 * 形如仓库根相对路径的字符串字面量（例如 import(pathToFileURL(path.resolve(ROOT, 'backend/x.js')).href)）；
 * freshImport(suite.path) 这种按对象属性取路径的，认本文件里所有 `path: '仓库路径'` 属性值。其余不猜。
 *
 * import() / freshImport 加载到的模块对象，按用法确定用到了哪些导出：
 *   const { a, b } = await freshImport('x')   → a、b
 *   const mod = await import('x'); mod.a      → a
 *   mod['a']                                  → a
 *   mod[suite.createName]                     → 本文件里所有 `createName: '…'` 属性的字符串值
 * 模块对象被传给函数、展开、或下标取不到对应属性值时，按全部导出都用到处理。
 * bare package specifier 按外部依赖处理；仓库若使用路径别名，落地前必须按仓库约定补充解析。
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

const CODE_PATH_RE = /^[\w.-]+(\/[\w.-]+)+\.(js|jsx|mjs|cjs)$/;

// import() 参数是表达式时，其中像仓库根相对路径的字符串字面量
function embeddedPaths(source) {
  return [...walk(source)].map(([n]) => stringValue(n)).filter((v) => v && CODE_PATH_RE.test(v));
}

function parentMap(tree) {
  const parents = new Map();
  for (const [node, parent] of walk(tree)) parents.set(node, parent);
  return parents;
}

// 本文件里 `key: '字符串'` 形式的属性值；一个都没有时返回 null
function propertyStrings(tree, key) {
  const values = [];
  for (const [node] of walk(tree)) {
    if (node.type !== 'Property' || node.computed || moduleName(node.key) !== key) continue;
    const value = stringValue(node.value);
    if (value !== null) values.push(value);
  }
  return values.length ? values : null;
}

// mod[key] 里 key 能对应到的导出名；认不出返回 null
function computedNames(tree, key) {
  const literal = stringValue(key);
  if (literal !== null) return [literal];
  if (key.type === 'MemberExpression' && !key.computed) return propertyStrings(tree, key.property.name);
  return null;
}

function patternKeys(pattern, tree) {
  const names = [];
  for (const prop of pattern.properties) {
    if (prop.type === 'RestElement') return [ALL];
    const name = prop.computed ? computedNames(tree, prop.key) : [moduleName(prop.key)];
    if (!name) return [ALL];
    names.push(...name);
  }
  return names;
}

// 名为 name 的模块对象在本文件里被取用的导出名
function memberNames(tree, parents, name) {
  const names = new Set();
  for (const [node, parent] of walk(tree)) {
    if (node.type !== 'Identifier' || node.name !== name) continue;
    if (parent?.type === 'MemberExpression' && parent.object === node) {
      const picked = parent.computed ? computedNames(tree, parent.property) : [parent.property.name];
      if (!picked) return [ALL];
      picked.forEach((n) => names.add(n));
    } else if (parent?.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'ObjectPattern') {
      patternKeys(parent.id, tree).forEach((n) => names.add(n));
    } else if ((parent?.type === 'VariableDeclarator' && parent.id === node)
        || (parent?.type === 'AssignmentExpression' && parent.left === node)
        || (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
        || (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)) {
      continue;
    } else {
      return [ALL];
    }
  }
  return [...names];
}

// 动态加载结果被怎样接住，决定用到哪些导出
function loadedNames(tree, parents, loadNode) {
  let node = loadNode;
  let parent = parents.get(node);
  while (parent?.type === 'AwaitExpression') {
    node = parent;
    parent = parents.get(node);
  }
  if (parent?.type === 'VariableDeclarator' && parent.init === node) {
    if (parent.id.type === 'ObjectPattern') return patternKeys(parent.id, tree);
    if (parent.id.type === 'Identifier') return memberNames(tree, parents, parent.id.name);
  }
  if (parent?.type === 'AssignmentExpression' && parent.right === node && parent.left.type === 'Identifier') {
    return memberNames(tree, parents, parent.left.name);
  }
  return [ALL];
}

// freshImport 的参数：字面量路径，或 suite.path 这种按属性名取的仓库路径
function rootImportTargets(tree, arg) {
  const literal = stringValue(arg);
  if (literal !== null) return [literal];
  if (arg?.type === 'MemberExpression' && !arg.computed) {
    return (propertyStrings(tree, arg.property.name) ?? []).filter((v) => CODE_PATH_RE.test(v));
  }
  return [];
}

// 返回 { refs: [{ base, names, lazy }], exports: [{ name, line }] }；base 是待解析的仓库相对路径，
// lazy 表示运行到这里才加载（import() / freshImport），不构成加载期的循环
function moduleShape(rel, tree) {
  const refs = [];
  const exports = [];
  const ref = (base, names, lazy = false, specifier = base) => refs.push({ base, names, lazy, specifier });
  const exported = (node, names) => names.forEach((name) => exports.push({ name, line: node.loc.start.line }));
  const parents = parentMap(tree);
  for (const [node] of walk(tree)) {
    if (node.type === 'ImportDeclaration') {
      const specifier = node.source.value;
      ref(relative(rel, specifier), importNames(node), false, specifier);
    }
    else if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) exported(node, declarationNames(node.declaration));
      exported(node, node.specifiers.map((s) => moduleName(s.exported)));
      if (node.source) {
        const specifier = node.source.value;
        ref(relative(rel, specifier), node.specifiers.map((s) => moduleName(s.local)), false, specifier);
      }
    } else if (node.type === 'ExportAllDeclaration') {
      const specifier = node.source.value;
      ref(relative(rel, specifier), [ALL], false, specifier);
      if (node.exported) exported(node, [moduleName(node.exported)]);
    } else if (node.type === 'ExportDefaultDeclaration') exported(node, ['default']);
    else if (node.type === 'ImportExpression') {
      const literal = stringValue(node.source);
      const names = loadedNames(tree, parents, node);
      if (literal !== null) ref(relative(rel, literal), names, true, literal);
      else embeddedPaths(node.source).forEach((base) => ref(base, names, true, base));
    } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.arguments.length === 1) {
      if (node.callee.name === 'require') {
        const specifier = stringValue(node.arguments[0]);
        ref(relative(rel, specifier), [ALL], false, specifier);
      }
      else if (ROOT_IMPORTERS.has(node.callee.name)) {
        const names = loadedNames(tree, parents, node);
        rootImportTargets(tree, node.arguments[0]).forEach((base) => ref(base, names, true, base));
      }
    }
  }
  return { refs, exports };
}

// 返回已解析模块和 unresolvedStaticImports；后者列出无法解析的确定性仓内引用。
// scan 可传入同一批文件的 parseFiles 结果，供已有 detector 复用解析结果。
export function buildImportGraph(root, rels, scan = null) {
  const fileSet = new Set(rels);
  const { parsed, parseFailures } = scan ?? parseFiles(root, rels);
  const modules = new Map();
  const unresolvedStaticImports = [];
  for (const { rel, tree } of parsed) {
    const { refs, exports } = moduleShape(rel, tree);
    const resolved = [];
    for (const { base, names, lazy, specifier } of refs) {
      const target = base && resolveFile(fileSet, base);
      if (!target) {
        if (base !== null) unresolvedStaticImports.push({ source: rel, target: base, specifier, lazy });
        continue;
      }
      if (target !== rel) resolved.push({ target, names, lazy });
    }
    const seen = new Set();
    modules.set(rel, { exports: exports.filter((e) => !seen.has(e.name) && seen.add(e.name)), refs: resolved });
  }
  unresolvedStaticImports.sort((a, b) => {
    const left = `${a.source}\0${a.target}\0${a.specifier}`;
    const right = `${b.source}\0${b.target}\0${b.specifier}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { fileSet, parsed, parseFailures, modules, unresolvedStaticImports };
}
