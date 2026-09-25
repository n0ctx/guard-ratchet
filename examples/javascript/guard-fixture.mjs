/**
 * 守卫夹具测试的共用部分：在临时目录搭一个小仓库，对它运行守卫脚本，测试结束后删除
 */

import { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function useGuardFixture(scriptName) {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  return {
    makeRoot() {
      const root = mkdtempSync(path.join(os.tmpdir(), 'we-guard-'));
      dirs.push(root);
      return root;
    },
    write(root, rel, text) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    },
    run(root, ...args) {
      return spawnSync(process.execPath, [path.join(SCRIPTS_DIR, scriptName), '--root', root, ...args], { encoding: 'utf8' });
    },
  };
}
