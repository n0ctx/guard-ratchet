# 各语言做法

先看仓库里已经有什么，再从这里挑。表里的工具都需要把输出转换成发现（`rule`、`key`、`count`），再交给棘轮比对——工具自己的「阈值报错」模式不具备基线语义，不要直接用它的退出码当守卫结果。

引入工具时：
- 固定版本（锁文件、`requirements` 里的 `==`、`go run pkg@vX`），工具升级改变计数会让基线大面积变动。
- 引入新依赖前先问用户。
- 工具的 key 格式（例如行号）不稳定时，在转换层改写成 `路径#符号名` 或内容哈希。

## 跨语言

| 需求 | 工具 | 备注 |
|---|---|---|
| 复杂度 | lizard | 支持 C/C++、Java、C#、JS/TS、Python、Go、Rust、Swift、Kotlin 等，输出 CSV/XML |
| 重复 | jscpd | 支持大量语言，有 JSON 报告；用它的片段内容做哈希当 key，不要用行号 |
| 自研检测 | tree-sitter | 多语言统一的语法树，适合没有好用原生解析器时自己写规则 |

## JavaScript / TypeScript

- 解析：espree（ESLint 自带，纯 JS）、@babel/parser、typescript 编译器 API、@typescript-eslint/typescript-estree。项目里已装 ESLint 时 espree 通常已在依赖树中，可以零新增依赖。
- 复杂度：ESLint `complexity` 规则 + `-f json`；或自己按 AST 计数（见 `examples/javascript/check-complexity.mjs`）。
- 死代码：knip（未用文件、导出、依赖），对 monorepo 和各种框架约定有内建支持。
- 重复：jscpd。
- 架构边界：先复用仓库已有 import graph；其次考虑 dependency-cruiser 的禁止依赖和分层规则，或仓库已有生态里的 ESLint `import/no-internal-modules`。自研时沿用简单路径边规则。
- 循环依赖：madge（`--circular --json`）、dependency-cruiser（还能写分层规则）。
- 测试形态：自己按 AST 查 `it/test/describe` 调用、`.only`、`expect(`、`setTimeout` 字面量。
- 约定式加载要留意：Next.js/Nuxt 等文件路由、Vite/ESLint/Vitest 配置文件、`React.lazy(() => import('...'))`、测试辅助的字符串路径加载。
- 完整参照实现：`examples/javascript/`。

## Python

- 解析：标准库 `ast`，无需依赖。
- 复杂度：radon（`radon cc -j`）或 lizard；也可以用 `ast` 自己计数。
- 死代码：vulture（带置信度，建议只取 100% 置信的或自己设门槛）；自研时用 `ast` 建 import 图。
- 重复：pylint 的 duplicate-code（R0801）或 jscpd。
- 架构边界：import-linter 可检查分层、禁止导入和 package boundary。
- 循环依赖：用 `ast` 建 import 图求强连通分量。`from pkg import sub` 的边落到子模块、不连包入口，见 `guard-catalog.md` 第 7 节。
- 测试形态：pytest 的 `@pytest.mark.skip`、`pytest.skip()`、`time.sleep(x)`；没有 `assert` 语句也没有 `pytest.raises`/mock 断言的测试函数。
- N+1：循环或推导式里对 ORM 的逐项查询（Django `Model.objects.get`、SQLAlchemy `session.get/execute`、`cursor.execute`）。`ast.For.iter` 和推导式 `generators[0].iter` 只求值一次，不算循环里，见 `guard-catalog.md` 第 6 节。
- 约定式加载：`conftest.py`、Django 的 `apps.py`/`admin.py`/`migrations`、`entry_points`、`__init__.py` 的再导出、插件目录。

## Go

- 解析：标准库 `go/parser`、`go/ast`；类型信息用 `golang.org/x/tools/go/packages`。
- 复杂度：gocyclo、gocognit。
- 死代码：`golang.org/x/tools/cmd/deadcode`（从 main 出发的可达性）、staticcheck 的 U1000。
- 重复：dupl。
- 循环依赖：Go 编译器禁止 package import cycle，不需要这个守卫；package/module 的依赖方向仍可单独守。
- 测试形态：Go 没有断言库时以 `t.Error*`/`t.Fatal*`/testify 调用为断言；`t.Skip`；`time.Sleep`。
- N+1：循环里调用 `db.Query*`/`QueryRow*`/`Exec*` 或 repository 方法。

## Java / Kotlin

- 解析：JavaParser；Kotlin 用 kotlin-compiler-embeddable 的 PSI 或 detekt 的规则框架。
- 复杂度：PMD（CyclomaticComplexity）、detekt（Kotlin）、lizard。
- 重复：PMD CPD。
- 架构边界与循环依赖：ArchUnit 可检查 layered architecture、slices/cycles、package access 和依赖方向，写成测试即可。
- 测试形态：`@Disabled`/`@Ignore`、`Thread.sleep`、没有 assert/verify 的 `@Test` 方法。

## Rust

- 解析：`syn` crate。
- 复杂度：clippy 的 `cognitive_complexity` lint，或 lizard。
- 死代码：编译器的 `dead_code` 警告只管 crate 内私有项；对外 `pub` 的项需要自己按引用图查。
- 循环依赖：crate 之间 cargo 已禁止；crate 内模块互相引用是允许的，一般不做守卫。
- 测试形态：`#[ignore]`、`std::thread::sleep`、没有 `assert!`/`assert_eq!` 的 `#[test]`。

## C / C++

- 复杂度：lizard。
- 死代码：cppcheck（unusedFunction，需整程序分析）。
- 重复：jscpd、PMD CPD。
- 循环依赖：按 `#include` 建图（头文件互相包含）。

## 其他语言

没有列出的语言：先找该语言主流 linter 是否有复杂度/未使用代码规则，再看 lizard、jscpd、tree-sitter 能否覆盖；都不够再用该语言的官方解析器自己写。
