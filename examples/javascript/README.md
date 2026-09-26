# JavaScript 参照实现

六个在真实仓库（Express 后端 + React 前端 + SQLite）落地过的守卫，加一个最小架构边界参考实现。使用 espree 解析、Node 内建 `node:test` 做夹具测试，不依赖 `scripts/ratchet.py`；现有 JavaScript 守卫在 `guard-common.mjs` 里实现相同的棘轮语义。

写自研检测器时用来参照 AST 遍历、key 设计和夹具测试写法；**不要整套照搬**。下面这些常量属于原仓库，必须换成当前仓库的实际情况：

| 文件 | 常量 | 含义 |
|---|---|---|
| guard-common.mjs | `CODE_SUFFIXES`、`SKIP_DIRS` | 扫描扩展名；依赖、生成、构建、覆盖率和数据目录的排除项 |
| check-duplication.mjs / check-perf-shape.mjs | `SCAN_DIRS` | 正式代码目录 |
| check-perf-shape.mjs | `QUERY_DIR`、`DB_MODULE` | 查询层目录（用来识别业务层的 N+1）；数据库连接模块（判断查询层函数是否真的访问数据库） |
| check-perf-shape.mjs | `SQL_DIRS`、`SQL_EXEMPT` | 检查无条件 SELECT 的业务层目录与例外 |
| check-tests.mjs | `SCAN_DIRS`、`E2E_DIR`、`BACKEND_TEST_SCRIPTS` | 测试目录、端到端目录、需要排除端到端的测试命令 |
| check-dead-code.mjs | `ENTRY_FILES`、`HTML_ENTRIES`、`HOOK_FILE_RE` | 程序入口、HTML 入口、按目录加载的插件 |
| check-dead-code.mjs | `CONVENTION_ENTRIES`、`PUBLIC_API` | 按路径字符串加载或供复制的文件；对外约定的出口（导出不逐个报） |
| import-graph.mjs | `ROOT_IMPORTERS` | 测试里按字符串路径加载模块的辅助函数 |
| check-complexity.mjs | `MIN_FUNCTION_COUNT` | 扫描下限（防空转） |

复杂度守卫单独维护文件后缀和排除目录；实际落地时要分别核对各 detector 的扫描范围。

| 文件 | 内容 |
|---|---|
| guard-common.mjs | 遍历、解析、参数、基线读写与比对、`guard-allow` 有意保留标记 |
| import-graph.mjs | 仓内引用图（死代码、循环依赖、架构边界共用）；暴露无法解析的确定性引用 |
| guard-fixture.mjs | 夹具测试辅助：临时仓库、读写文件、运行守卫 |
| check-complexity.mjs | 圈复杂度（数值型基线） |
| check-duplication.mjs | 连续语句 token 序列查重（抹掉标识符） |
| check-dead-code.mjs | 无引用文件 / 无引用导出 |
| check-tests.mjs | 测试形态：无断言、.only、写死断言、长等待、playwright 位置、重复启动、skip |
| check-perf-shape.mjs | 三层循环、循环内查询（按 db-read / db-write 传播查询层 effect）、无条件 SELECT |
| check-cycles.mjs | 静态 import 循环依赖（硬规则） |
| check-architecture.mjs | 简单路径规则的架构边界参考实现（默认硬规则，可显式使用基线模式） |
| *.test.mjs | detector correctness 与 ratchet correctness 夹具测试 |

原仓库还有一个体量守卫（文件 token、函数长度等），体积较大未收录；思路见 `references/guard-catalog.md` 第 2 节。

## Detector Contract

夹具分开证明两类行为：

1. **Detector correctness**：positive、negative、boundary、stable key、parse failure、coverage failure。
2. **Ratchet correctness**：当前与 baseline 一致时通过、added finding 失败、stale baseline 失败。

这些行为可以合并在少量测试中；硬规则不需要 baseline equality 或 stale 用例。detector 的文件数、解析数、模块数和依赖边摘要用于观察实际扫描量。

运行形态方法论也定义 `network` effect；JavaScript 参考实现当前只计算 `db-read` 与 `db-write`，没有实现 HTTP client 识别。

`check-architecture.mjs` 中的 `frontend/`、`backend/routes/`、`backend/db/` 和 `features/` 都是示例目录。落地到真实仓库前必须按实际架构替换 `ARCH_RULES`；不要照搬这些目录约定。
