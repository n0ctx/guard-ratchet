import test from 'node:test';
import assert from 'node:assert/strict';

import { useGuardFixture } from './guard-fixture.mjs';

const { makeRoot, write, run } = useGuardFixture('check-dead-code.mjs');

function fixture() {
  const root = makeRoot();
  write(root, 'backend/server.js', "import { used } from './lib.js';\nconst page = await import('./pages/home');\nused(page);\n");
  write(root, 'backend/lib.js', 'export function used() {}\nexport const unused = 1;\n');
  write(root, 'backend/pages/home/index.js', 'export default 1;\n');
  write(root, 'backend/only-tested.js', 'export const x = 1;\n');
  write(root, 'backend/tests/only-tested.test.js', "import { x } from '../only-tested.js';\n");
  write(root, 'hooks/on-save.js', 'export default function hook() {}\n');
  write(root, 'tools/package.json', JSON.stringify({ scripts: { go: 'node ./run.mjs --fast' } }));
  write(root, 'tools/run.mjs', 'export const unusedInEntry = 1;\n');
  write(root, 'frontend/vite.config.js', 'export default {};\n');
  write(root, 'backend/modes.js', 'export const chatMode = 1;\n');
  write(root, 'backend/tests/modes.test.js', "const { chatMode } = await freshImport('backend/modes.js');\n");
  assert.equal(run(root, '--update-baseline').status, 0);
  return root;
}

test('现状与基线一致时通过，入口、配置文件与测试引用（含 freshImport）不报', () => {
  const root = fixture();
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /无引用文件 0 个、无引用导出 1 个/);
});

test('新增无引用文件和无引用导出失败', () => {
  const root = fixture();
  write(root, 'backend/orphan.js', 'export const o = 1;\n');
  write(root, 'backend/lib.js', 'export function used() {}\nexport const unused = 1;\nexport const extra = 2;\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backend\/orphan\.js/);
  assert.match(result.stderr, /backend\/lib\.js#extra/);
});

test('基线里的无引用导出删掉后未清理算虚挂', () => {
  const root = fixture();
  write(root, 'backend/lib.js', 'export function used() {}\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /基线与现状对不上[\s\S]*backend\/lib\.js#unused/);
});

test('在导出前插入无关内容不改变死代码 key', () => {
  const root = fixture();
  write(root, 'backend/lib.js', '// unrelated comment\nexport function used() {}\nexport const unused = 1;\n');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test('约定入口、对外出口、import() 表达式里的仓库路径和 guard-allow 标记都不报', () => {
  const root = fixture();
  write(root, 'desktop/src/preload.js', 'export const bridge = 1;\n');
  write(root, 'frontend/src/components/index.js', "export { default as Button } from './Button.jsx';\n");
  write(root, 'frontend/src/components/Button.jsx', 'export default function Button() {}\n');
  write(root, 'frontend/src/main.jsx', "import './components/index.js';\n");
  write(root, 'backend/log.js', 'export const level = 1;\n');
  write(root, 'backend/tests/log.test.js',
    "const mod = await import(pathToFileURL(path.resolve(ROOT, 'backend/log.js')).href);\nmod.level;\n");
  write(root, 'backend/lib.js', [
    'export function used() {}',
    'export const unused = 1;',
    '// guard-allow(dead-code): 外部系统按名字调用',
    'export const external = 2;',
    '',
  ].join('\n'));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /无引用文件 0 个、无引用导出 1 个/);
  assert.match(result.stdout, /backend\/lib\.js:3 外部系统按名字调用/);
});

test('动态加载的模块按取用的成员算引用：解构、点号、按属性名存的字符串下标', () => {
  const root = fixture();
  write(root, 'backend/q/a.js', 'export const pick = 1;\nexport const dotted = 2;\nexport const byKey = 3;\nexport const idle = 4;\n');
  write(root, 'backend/q/b.js', 'export const create = 1;\nexport const unusedB = 2;\n');
  write(root, 'backend/tests/q.test.js', [
    "const { pick } = await freshImport('backend/q/a.js');",
    "const mod = await freshImport('backend/q/a.js');",
    "mod.dotted; mod['byKey'];",
    "const suites = [{ path: 'backend/q/b.js', createName: 'create', otherName: 'unusedB' }];",
    'for (const suite of suites) { const m = await freshImport(suite.path); m[suite.createName]; }',
    '',
  ].join('\n'));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backend\/q\/a\.js#idle/);
  assert.match(result.stderr, /backend\/q\/b\.js#unusedB/);
  assert.doesNotMatch(result.stderr, /#(pick|dotted|byKey|create)\b/);
});

test('动态加载的模块对象被传出去时按全部导出都用到处理', () => {
  const root = fixture();
  write(root, 'backend/q/c.js', 'export const one = 1;\nexport const two = 2;\n');
  write(root, 'backend/tests/c.test.js', "const mod = await freshImport('backend/q/c.js');\ninspect(mod);\n");
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test('静态仓内引用无法解析时 detector health 失败', () => {
  const root = makeRoot();
  write(root, 'backend/server.js', "import './missing.js';\n");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /无法解析仓内静态引用：backend\/server\.js -> \.\/missing\.js/);

  write(root, 'backend/bad.js', 'export const = ;\n');
  const parseFailure = run(root);
  assert.equal(parseFailure.status, 1);
  assert.match(parseFailure.stderr, /解析失败：backend\/bad\.js/);

  const empty = run(makeRoot());
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /没有扫到任何文件/);
});
