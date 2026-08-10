<!-- ============================================================
  RULES.md — user-maintained ground truth for AI agents
  RULES.md —— 用户维护的恒真规则文件

  This file is authoritative and stable: it changes ONLY when the
  user edits it. Agents must follow it; if a rule conflicts with
  the code they observe, they should ask the user to clarify —
  never modify this file themselves.
  本文件权威且稳定：只在用户主动修改时变更。Agent 必须遵守；
  若规则与代码现实冲突，应向用户求证，而不是自行修改本文件。

  Syntax / 语法（示例都在注释内，加载时剥离，不进提示词）：
    %% comment %%                     placeholder for HTML comment mark;
                                      the real mark is angle-bracket
                                      wrapped and stripped at load
                                      （真实标记为尖括号包裹的注释形式，
                                      加载时剥离；此处用 %% 占位避免解析干扰）
    @import docs/x.md                 import a whole file
    @import docs/x.md#section         import one heading section
    @import docs/*.md                 glob import
    @rules max_depth 5                set limits
============================================================ -->

## 决策与理由 (why, not how)

- 本仓库是 pi 的独立扩展包，注册入口在 package.json 的 `pi.extensions`（./extensions/kernel.ts），与 pi-extensions 集合包分开维护
- 架构分层：扩展 = TypeScript（erasable 语法，运行时由 jiti 加载，无构建步骤）；内核服务 = Python（python/server.py）；两者只通过 stdio JSON-RPC（newline-delimited JSON）通信，互不 import、互不假设对方进程存在
- 执行器是抽象层：优先嵌入式 IPython InteractiveShell（magics/rich repr/异步支持），标准库 exec 引擎兜底（零依赖可跑）。未来挂其他语言内核是加实现，不是重构
- 内核进程模型：每个 pi 会话一个独立 Python 进程 + 独立会话层命名空间；全局层 = 同工作区内的跨会话共享（不同工作区不共享，需要时走显式导出/导入）
- 全局层存储 = 工作区 .kernel/store.sqlite（WAL 模式）。SQLite 就是锁：事务原子性 + WAL 读写并发 + 崩溃恢复都由存储引擎提供，不手写文件锁。这是唯一共享点，并发风险全部收敛于此
- 全局层对象存 SQLite BLOB，对象数据与元数据（名称、来源文件 hash、创建时间、版本号、描述）在同一事务提交；单对象默认上限 256MB，超限拒绝 publish
- publish 冲突语义：同名并发发布 = last-write-wins + 返回 overwritten 提示（agent 场景避免卡死）；可选 expected_version 参数做乐观锁
- 会话层（sessions/ 目录）物理隔离、即弃，不序列化、不跨上下文；进程崩溃留下的孤儿文件可清理
- 运行时：Python 3.13.x 固定，由 uv + python-build-standalone 引导（runtime.json 清单，固定版本 + SHA256 校验），首次使用内核工具时惰性下载到缓存目录，不依赖、不修改系统 Python；下载清单与代码分离，升版本只改清单
- 代码、注释、以及 agent 可见的输出（工具返回文本、错误消息）一律纯英文 ASCII；中文只允许出现在用户文档（README/RULES.md）
- 测试：Python 侧用标准库 unittest（零第三方依赖可跑）；TS 侧用 Node ≥22.18 原生类型剥离直接 import .ts（零 npm install 可跑）；被测试 import 的 .ts 顶层不得静态 import pi 运行时包

## 约束与陷阱 (not visible in the code)

- 扩展代码只用 erasable TS 语法（无 enum / namespace / 构造器参数属性），否则纯 Node 测试 import .ts 会崩
- 禁止任何代码绕过 SQLite 直接读写 .kernel/ 下的文件（破坏事务保证）；.kernel/ 已进 .gitignore，任何情况下不得提交
- 全局层只接受可安全序列化的对象（str/int/float/bool/None/list/dict/bytes + pandas/polars DataFrame/Series + numpy 标量与数组 + datetime）；其他类型（lambda、生成器、连接、类实例）publish 时拒绝并提示"导出为文件"，不做 cloudpickle 任意代码执行通道
- 快照过期：对象元数据记录来源文件 hash，ls/get 时校验；源文件变化 → 标记 invalid 并给出重建建议，不静默返回旧数据
- 读永远新鲜：会话进程不缓存全局层对象（只缓存元数据版本号），WAL 下任何事务提交后立即可见
- 会话层与全局层同名对象：会话层 shadow 全局层，不污染（写入会话层不改全局层）
- Python 进程生命周期：随 pi 会话退出而终止（会话结束清理）；进程内异常不得退出主循环，必须返回 error 响应
- 内核工具超时（默认 30s）由 TS 侧强制，超时后进程应能继续服务（interrupt 语义），不能整体杀掉

## 意图 (layout changes, intent does not)

- 本项目的最终形态是给 agent 一个"可跨上下文持久化的工作记忆"：代码/函数走重放（init 脚本注册），数据走快照（SQLite 带元数据），会话走即弃；agent 的工具面保持精简（4 个工具：kernel_run / kernel_ls / kernel_get / kernel_publish），低频功能降级为参数而不是升格为工具
- Jupyter messaging protocol 本身语言无关，执行器抽象层保留未来挂其他语言内核的可能，但当前只有 Python
- 持久化是工作区级资产（跟项目走），不是全局个人资产；跨工作区共享不在当前目标内
