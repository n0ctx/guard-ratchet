# Detector Contract

Ratchet Contract 规定发现如何与基线比较；Detector Contract 规定检测器必须满足什么条件，才可信到可以输出发现。两份契约职责不同，不要混在一起。

## 1. Deterministic

相同源码、配置和检测器版本，必须得到相同的 `findings`、`hard`、`advisory` 和 coverage 结果，输出顺序也必须稳定。

不得依赖文件系统随机顺序、当前时间、随机数、绝对路径或机器相关的临时路径。先按仓库相对路径排序文件，再按稳定 key 排序发现和诊断；不能让并行任务的完成顺序决定报告顺序。

## 2. Fail closed

以下情况都不能报告成“0 个发现”：

- 源码解析失败。
- 必需的配置无法读取。
- 必需的依赖图无法构建。
- 确定性的仓内引用无法解析。
- 检测器异常退出，或返回明显不完整的结果。

无法证明扫描有效时必须失败。不得把“无法检测”当成“没有问题”，也不得用无效扫描结果更新基线。

## 3. Coverage-aware

每个检测器都要说明原计划扫描多少、实际成功扫描多少、有哪些内容无法处理。指标按检测器的职责选择，不要求共用一套字段。

| 检测器 | 有意义的覆盖指标 |
|---|---|
| 复杂度 | `source_files`、`parsed_files`、`functions`、`parse_failures` |
| 依赖图 | `source_files`、`parsed_files`、`modules`、`resolved_edges`、`unresolved_static_imports` |
| 测试形态 | `test_files`、`parsed_files`、`test_cases` |
| 死代码 | `source_files`、`modules`、`import_edges` |

最低要求：`planned > 0`，所有计划内文件都成功解析，关键实体数量不低于该检测器设定的保守下限。确定性的未解析输入必须出现在 detector health 里，不能从依赖图中静默消失。本来无法由静态分析确定的动态表达式可以作为已说明的限制。

文件类检测器要在解析前统计发现的范围内文件数，只把成功解析的文件计入 `parsed`。图类检测器要区分已解析文件、建成的模块、已解析的边和未解析的确定性引用。

如果检测器扫描文件但又要求函数数下限，摘要要同时报告这两个单位。下限应足以发现扫描范围意外缩小，不需要适配所有仓库的相同规模。

比较发现和更新基线之前，必须执行相同的 health 检查。用户请求更新基线不能成为接受无效扫描的理由。

通过摘要应让人看得出扫描量，例如“73 个文件 / 1540 个函数”或“83 个模块 / 241 条静态依赖边”。指标保留在各检测器内部，不要新增统一 reporter。

## 4. Stable identity

无关改动不得改变已有 finding key，具体包括：

- 插入无关代码行后，key 不变。
- 格式化后，key 不变。
- 在其他函数之前增加无关函数后，其他函数的 key 不变。

key 可以使用仓库相对路径（统一 `/`）加符号名、局部稳定区分符，或规范化内容 hash。禁止使用行号、列号、全文件匿名函数顺序编号和临时绝对路径。

key 应标识受影响的实体或依赖关系，而不是解析器碰巧遇到它的位置。同名区分符只能用于区分确实同名的局部实体；在其他位置增加实体不能让已有 key 重新编号。

对于模块对等集合型关系，同一关系只报告一次。不要让同一条依赖边因为多处 import 而重复出现。

## 5. No silent unknowns

检测器遇到无法处理的确定性代码结构时，必须失败或明确列入 detector health 的 unsupported 项，不能直接忽略。

需要进入 detector health 的例子：

- 字面量 `import("./known-file.js")` 无法解析到目标文件。
- 合法源码无法被指定的 parser 解析。
- 仓库相对路径的 resolve 逻辑损坏。

可以作为限制保留的例子：

- `import(variable)` 这类变量式动态路径。
- 反射。
- 运行时 dependency-injection container。

必须区分“本来就未知的动态输入”和“确定的字面量引用解析失败”。仓库别名或框架加载约定也要明确说明是否已解析。

## 6. Fixture-proven

夹具必须分别证明 detector correctness 和 Ratchet Contract 的行为。

**Detector correctness** 必须覆盖：

- positive：真实违规能被发现。
- negative：明确合法的代码不会误报。
- boundary：门槛和扫描范围边界符合定义。
- stable key：无关改动不改变已有 key。
- parse failure：扫描范围内无法解析的文件导致失败。
- coverage failure：空扫描或覆盖明显不完整时失败。

**Ratchet correctness** 必须覆盖：

- 当前发现与基线一致：通过。
- 新增发现：失败。
- 违规改善或消失但基线未收紧：以 stale 失败。

硬规则不需要与基线相等或 stale 相关的用例。多个行为可以合并到少量测试中，不要求固定测试函数数量。成熟外部工具不必重测其内部算法，但要测试输出转换、key 归一化、覆盖检查、失败传播和 ratchet 接合。

夹具应让边界清楚可见：数值门槛测试门槛值及刚超过门槛的值；依赖图测试允许边和禁止边；稳定 key 测试插入无关行或新增无关模块后的 key。

## 7. Scope correctness

必须记录：

- 扫描哪些目录、哪些目录明确排除。
- 正式代码与测试如何区分，测试是否由单独检测器扫描。
- 生成代码按目录还是命名约定排除。
- 第三方或 vendored 代码如何识别。
- 仓库路径别名和框架约定是否已解析，未覆盖时限制是什么。

不得为方便把 `node_modules`、`vendor`、构建产物、coverage 产物或生成代码计入源码指标。排除项应尽量与仓库已有检查一致，并且代码目录或命名约定变更时重新核对覆盖范围。

让扫描范围常量容易检查，并用夹具证明关键的纳入项和排除项确实生效。

## Detector acceptance checklist

- [ ] deterministic
- [ ] fail closed
- [ ] coverage-aware
- [ ] stable key
- [ ] no silent unknowns
- [ ] fixture-proven
- [ ] scope documented
