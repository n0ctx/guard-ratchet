import test from 'node:test';
import assert from 'node:assert/strict';

import { useGuardFixture } from './guard-fixture.mjs';

const { makeRoot, write, run } = useGuardFixture('check-perf-shape.mjs');

const QUERIES = `export function reorder(db, ids) {
  const stmt = db.prepare('UPDATE t SET sort = ? WHERE id = ?');
  ids.forEach((id, i) => stmt.run(i, id));
  const all = db.prepare('SELECT * FROM t').all();
  const map = new Map(all.map((r) => [r.id, r]));
  for (const id of ids) map.get(id);
}
`;

function fixture() {
  const root = makeRoot();
  write(root, 'backend/db/queries/t.js', QUERIES);
  write(root, 'backend/routes/list.js', "export const sql = 'SELECT id FROM t';\n");
  write(root, 'backend/services/import-export.js', "export const sql = 'SELECT * FROM t';\n");
  write(root, 'frontend/src/grid.js', [
    'export function grid(rows, cols) {',
    '  for (const r of rows) { for (const c of cols) { let n = 0; while (n < 3) n += 1; } }',
    '}',
    '',
  ].join('\n'));
  assert.equal(run(root, '--update-baseline').status, 0);
  return root;
}

test('现状与基线一致时通过，两层循环与内存匹配不报', () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /循环内查询 1 处、无 WHERE\/LIMIT 的 SELECT 1 处/);
});

test('业务层在循环或数组遍历回调里调用查询层函数失败', () => {
  const root = fixture();
  write(root, 'backend/services/items.js', [
    "import { getById } from '../db/queries/items.js';",
    "import * as q from '../db/queries/tags.js';",
    'export const load = (ids) => ids.map((id) => getById(id));',
    'export function tags(ids) { for (const id of ids) q.listTags(id); }',
    '',
  ].join('\n'));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backend\/services\/items\.js#load#getById/);
  assert.match(result.stderr, /backend\/services\/items\.js#tags#q\.listTags/);
});

test('三层循环引用外层变量、新增循环内查询、新增无条件 SELECT 都失败', () => {
  const root = fixture();
  write(root, 'frontend/src/deep.js', [
    'export function deep(a, b, c) {',
    '  for (const x of a) { b.forEach((y) => { for (const z of c) { if (z === x) return; } }); }',
    '}',
    '',
  ].join('\n'));
  write(root, 'backend/services/load.js', [
    "export function load(db, ids) { for (const id of ids) db.prepare('SELECT * FROM t WHERE id = ?').get(id); }",
    'export const sql = `SELECT name FROM t ORDER BY name`;',
    '',
  ].join('\n'));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deep\.js:2 循环嵌套 3 层，最内层引用了外层循环变量 x/);
  assert.match(result.stderr, /backend\/services\/load\.js#load#db\.prepare/);
  assert.match(result.stderr, /backend\/services\/load\.js#\(顶层\)#SELECT name FROM t ORDER BY name/);
});

test('基线里的循环内查询消失后未清理算虚挂', () => {
  const root = fixture();
  write(root, 'backend/db/queries/t.js', 'export function reorder() {}\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /基线与现状对不上[\s\S]*t\.js#reorder#stmt\.run/);
});

test('事务里逐条写预编译语句不报，事务里逐条读照报', () => {
  const root = fixture();
  write(root, 'backend/db/queries/batch.js', [
    "import db from '../index.js';",
    'function insertAll(stmt, rows) { for (const r of rows) stmt.run(r); }',
    'export function save(rows) {',
    "  const stmt = db.prepare('INSERT INTO t VALUES (?)');",
    "  const read = db.prepare('SELECT * FROM t WHERE id = ?');",
    '  db.transaction(() => {',
    '    insertAll(stmt, rows);',
    '    rows.forEach((r) => stmt.run(r));',
    '    for (const r of rows) read.get(r);',
    '  })();',
    '}',
    '',
  ].join('\n'));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /batch\.js#save#read\.get/);
  assert.doesNotMatch(result.stderr, /stmt\.run/);
});

test('查询目录里不碰数据库的纯函数不算查询', () => {
  const root = fixture();
  write(root, 'backend/db/queries/items.js', [
    "import db from '../index.js';",
    'export function normalize(v) { return Number(v) || 1; }',
    "export function getById(id) { return db.prepare('SELECT * FROM items WHERE id = ?').get(id); }",
    'export function getViaHelper(id) { return getById(id); }',
    '',
  ].join('\n'));
  write(root, 'backend/services/items.js', [
    "import { normalize, getViaHelper } from '../db/queries/items.js';",
    'export function load(ids) { for (const id of ids) { normalize(id); getViaHelper(id); } }',
    '',
  ].join('\n'));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /items\.js#load#getViaHelper/);
  assert.doesNotMatch(result.stderr, /#normalize/);
});

test('guard-allow 标记覆盖紧随其后的语句段，并在输出里列出', () => {
  const root = fixture();
  write(root, 'backend/services/seed.js', [
    "import { getById } from '../db/queries/items.js';",
    'export function seed(ids) {',
    '  // guard-allow(perf-shape): 固定小表',
    '  const first = ids[0];',
    '  for (const id of ids) getById(id, first);',
    '',
    '  for (const id of ids) getById(id);',
    '}',
    '',
  ].join('\n'));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.match(/seed\.js#seed#getById/g)?.length, 1);
  assert.match(result.stderr, /有意保留（guard-allow）1 处：\n {2}backend\/services\/seed\.js:3 固定小表/);
});

test('guard-allow 没写理由、守卫名写错、已无违规都失败', () => {
  const root = fixture();
  write(root, 'backend/services/marks.js', [
    '// guard-allow(perf-shape)',
    'export const a = 1;',
    '// guard-allow(perf): 写错名字',
    'export const b = 2;',
    '// guard-allow(perf-shape): 这里其实没有循环查询',
    'export const c = 3;',
    '',
  ].join('\n'));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /marks\.js:1 标记没写理由/);
  assert.match(result.stderr, /marks\.js:3 守卫名 `perf` 不存在/);
  assert.match(result.stderr, /marks\.js:5 覆盖的代码里已经没有 perf-shape 违规/);
});
