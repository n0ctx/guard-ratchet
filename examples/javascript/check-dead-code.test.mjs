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

test('约定入口、对外出口、import() 表达式里的仓库路径和 guard-allow 标记都不报', () => {
  const root = fixture();
  write(root, 'desktop/src/preload.js', 'export const bridge = 1;\n');
  write(root, 'frontend/src/components/index.js', "export { default as Button } from './Button.jsx';\n");
  write(root, 'frontend/src/components/Button.jsx', 'export default function Button() {}\n');
  write(root, 'frontend/src/main.jsx', "import './components/index.js';\n");
  write(root, 'backend/log.js', 'export const level = 1;\n');
  write(root, 'backend/tests/log.test.js',
    "const mod = await import(pathToFileURL(path.resolve(ROOT, 'backend/log.js')).href);\n");
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
