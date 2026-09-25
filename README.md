# guard-ratchet

一个 agent skill：让 AI 编程助手在任意仓库里落地「只许变好」的源码守卫。

现有问题不要求当天修完，先记进基线；此后新增的问题、已有问题变严重、以及修好了却没从基线删掉的条目，都会让 lint / CI 失败。代码变坏几乎从来不是一次改动造成的，棘轮把每一次「只加一点」都变成显式决定：要么修掉，要么在提交里写明理由更新基线。

## 覆盖的守卫

| 守卫 | 查什么 |
|---|---|
| 圈复杂度 | 函数复杂度超过门槛；已超标的只许降 |
| 体量 | 文件长度、函数长度、定义数、依赖数 |
| 测试形态 | 没有断言、提交了 `.only`、写死结果的断言、长的固定等待、永久跳过 |
| 死代码 | 没人引用的文件、没人引用的导出 |
| 重复代码 | 抹掉标识符后仍相同的连续语句 |
| 运行形态 | 循环里逐条查库（N+1）、三层嵌套循环、没有 WHERE/LIMIT 的 SELECT |
| 循环依赖 | 模块之间加载期互相引用 |

skill 不会一股脑全上，而是按仓库实际情况挑选，例如没有数据库就不加 N+1 守卫，Go 编译器已禁止包循环就不加循环依赖守卫。

## 设计

分两层：

- **棘轮**（不随仓库变化）：发现与基线怎么比、什么算失败、基线怎么更新。由规格 `references/contract.md`、参考实现 `scripts/ratchet.py`（Python 标准库，无依赖）和一致性用例 `conformance/cases.json` 固定下来。
- **检测器**（随语言和仓库变化）：由 agent 在当前仓库里按顺序选择——仓库已有工具 → 成熟的现成工具 → 用该语言的解析器自己写。

检测器只需输出 `{rule, key, count}` 形式的发现；比对可以直接调用 `ratchet.py`，也可以用仓库主语言重写，只要通过全部一致性用例。

## 安装

skill 是一个目录，核心是 `SKILL.md`。放到你的 agent 会读取 skill 的位置即可：

```bash
git clone https://github.com/n0ctx/guard-ratchet ~/.agents/skills/guard-ratchet

# Claude Code 读取 ~/.claude/skills/
ln -s ~/.agents/skills/guard-ratchet ~/.claude/skills/guard-ratchet
```

不支持 skill 的 agent：让它先读 `SKILL.md` 再按流程做即可，文件里没有依赖特定工具名的指令。

## 使用

直接描述需求，不必提 skill 名字，例如：

- 「给 make lint 加几道检查：函数复杂度不许超过 10、不许出现没人用的模块、不许在循环里一条条查库。已有的问题先记下来，以后只许变少。」
- 「npm run lint 加上复制粘贴检查和循环依赖检查，不要加依赖。src/report.js 里有同事没提交的改动，别让它混进基线。」
- 「Go 项目，复杂度超过 15 的函数不许新增、已有的不许再变复杂。」

agent 会按 `SKILL.md` 的流程：摸清仓库 → 选守卫 → 选检测器 → 实现 → 从干净提交生成基线 → 接入 lint/CI → 为每个守卫写夹具测试 → 汇报。

单独使用参考实现：

```bash
python3 scripts/ratchet.py conformance                      # 跑一致性用例
my-detector | python3 scripts/ratchet.py check  --findings - --baseline guards/complexity.json
my-detector | python3 scripts/ratchet.py update --findings - --baseline guards/complexity.json
```

## 目录

```
SKILL.md                      流程与验收标准（agent 入口）
references/
  contract.md                 棘轮语义、发现与基线格式、命令行约定
  guard-catalog.md            每种守卫的信号、key 设计、默认门槛、常见误报
  language-recipes.md         各语言可用的解析器和现成工具
  pitfalls.md                 真实落地时踩过的坑
scripts/ratchet.py            棘轮参考实现
conformance/cases.json        棘轮一致性用例
examples/javascript/          一套落地过的 JavaScript 实现（espree，6 个守卫，含夹具测试）
```

## 评测

用 Claude Sonnet 5 在三个小仓库上对比「带 skill」与「不带 skill」，每个配置各跑 1 次，交付后用程序检查（在仓库副本上注入违规再跑 lint）：

| 仓库 | 带 skill | 不带 skill |
|---|---|---|
| Python：复杂度、死代码、N+1 | 9/9 | 7/9 |
| Node：重复代码、循环依赖，工作区有同事未提交的改动 | 9/9 | 6/9 |
| Go：复杂度、N+1 | 8/8 | 6/8 |

两边都能做出能跑的守卫；差距集中在：修好问题后不更新基线能否被拦住（3/3 对 0/3）、守卫本身有没有测试（3/3 对 0/3）、查重是否按每处出现计数。带 skill 耗时约为 3 倍。样本很小，仅供参考。
