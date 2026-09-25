# JavaScript 参照实现

一套在真实仓库（Express 后端 + React 前端 + SQLite）落地过的守卫，espree 解析，Node 内建 `node:test` 做夹具测试，不依赖 `scripts/ratchet.py`，而是在 `guard-common.mjs` 里用 JS 实现了同样的棘轮语义。

写自研检测器时用来参照 AST 遍历、key 设计和夹具测试写法；**不要整套照搬**。下面这些常量属于原仓库，必须换成当前仓库的实际情况：

| 文件 | 常量 | 含义 |
|---|---|---|
| check-duplication.mjs / check-perf-shape.mjs | `SCAN_DIRS` | 正式代码目录 |
| check-perf-shape.mjs | `QUERY_DIR` | 查询层目录（用来识别业务层的 N+1） |
| check-perf-shape.mjs | `SQL_DIRS`、`SQL_EXEMPT` | 检查无条件 SELECT 的业务层目录与例外 |
| check-tests.mjs | `SCAN_DIRS`、`E2E_DIR`、`BACKEND_TEST_SCRIPTS` | 测试目录、端到端目录、需要排除端到端的测试命令 |
| check-dead-code.mjs | `ENTRY_FILES`、`HTML_ENTRIES`、`HOOK_FILE_RE` | 程序入口、HTML 入口、按目录加载的插件 |
| import-graph.mjs | `ROOT_IMPORTERS` | 测试里按字符串路径加载模块的辅助函数 |
| check-complexity.mjs | `MIN_FUNCTION_COUNT` | 扫描下限（防空转） |

| 文件 | 内容 |
|---|---|
| guard-common.mjs | 遍历、解析、参数、基线读写与比对 |
| import-graph.mjs | 仓内引用图（死代码与循环依赖共用） |
| guard-fixture.mjs | 夹具测试辅助：临时仓库、写文件、运行守卫 |
| check-complexity.mjs | 圈复杂度（数值型基线） |
| check-duplication.mjs | 连续语句 token 序列查重（抹掉标识符） |
| check-dead-code.mjs | 无引用文件 / 无引用导出 |
| check-tests.mjs | 测试形态：无断言、.only、写死断言、长等待、playwright 位置、重复启动、skip |
| check-perf-shape.mjs | 三层循环、循环内查询（含业务层调用查询层）、无条件 SELECT |
| check-cycles.mjs | 静态 import 循环依赖（硬规则） |
| *.test.mjs | 每个守卫的三结果夹具测试 |

原仓库还有一个体量守卫（文件 token、函数长度等），体积较大未收录；思路见 `references/guard-catalog.md` 第 2 节。
