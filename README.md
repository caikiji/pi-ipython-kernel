# pi-ipython-kernel

给 pi agent 一个**可跨上下文持久化的 Python 工作内核**：`kernel_run` 执行代码并让变量存活，`kernel_publish` 把结果发布到工作区全局层，任何后续会话用 `kernel_get` 取回。简单说——把 agent 的"工作记忆"从易失的上下文窗口搬到持久的内核里。

```
会话 A: kernel_run 定义 df → kernel_publish df
会话 B: kernel_ls 发现 df → kernel_get 取回 → kernel_run 直接用
```

## 四个工具

| 工具 | 频率 | 作用 |
|---|---|---|
| `kernel_run(code, timeout?)` | 高频 | 在持久内核里执行 Python，返回输出 + 命名空间差异（new/changed/removed） |
| `kernel_ls(scope?, pattern?, detail?)` | 会话开场 | 列出会话层变量 + 全局层对象（含版本/大小/过期标记） |
| `kernel_get(name, summarize?, scope?, force?)` | 取结果 | 取对象摘要（或全量），全局对象自动注入会话命名空间 |
| `kernel_publish(name, description, source?, expected_version?)` | 交接 | 发布会话对象到全局层，强制描述，可带源文件做过期校验 |

设计原则：**低频功能降级为参数，不升格为工具**——validate/describe/load/status 全部内嵌在 ls/get 的行为里，工具面保持 4 个。

## 架构

```
pi 扩展 (TypeScript, jiti 加载)
  extensions/kernel.ts      ← 注册 4 工具、会话生命周期、运行时引导
  src/                      ← RPC 客户端 / 进程管理 / 格式化 / 运行时引导
        │ stdio newline-delimited JSON
        ▼
内核服务 (Python, 每会话一个进程)
  python/server.py          ← 执行器抽象：IPython InteractiveShell 优先，
  python/storage.py            标准库 exec 引擎兜底（零依赖可跑）
  python/summarize.py       ← 类型感知摘要
  python/runtime.json       ← 运行时清单（版本与代码分离）
```

- **执行器抽象**：Jupyter messaging protocol 语言无关，未来挂其他语言内核是加实现，不是重构
- **进程模型**：每个 pi 会话一个独立 Python 进程 + 独立会话命名空间；会话结束进程终止，会话层即弃

## 持久化模型

```
工作区/
├── .kernel/
│   └── store.sqlite      # 全局层：唯一跨会话共享点（WAL 模式）
└── .gitignore            # .kernel/ 永不提交
```

- **三层状态**：代码/函数走重放（init 脚本注册，M5+ 规划），数据走快照（SQLite 带元数据），会话走即弃
- **SQLite 就是锁**：事务原子性 + WAL 读写并发 + 崩溃恢复由存储引擎提供，不手写文件锁；多会话并发 publish 安全（last-write-wins + 覆盖提示，可选 `expected_version` 乐观锁）
- **安全序列化**：只接受白名单类型（str/int/float/bool/None/bytes/datetime/list/dict + numpy 标量与数组 + pandas/polars DataFrame/Series），JSON 兜底 / npy / parquet 编码，**不做 pickle/cloudpickle 任意代码执行通道**；其他类型发布时拒绝并提示"导出为文件"
- **快照过期**：publish 时可声明 `source=<文件>`，记录源文件 hash；源文件变化后 ls/get 标记 INVALID 并给出重建建议，不静默返回旧数据（`force=true` 可显式取回）
- **读永远新鲜**：会话进程不缓存全局层对象，任何事务提交后立即可见
- **Shadow 语义**：会话层与全局层同名对象，会话层优先（scope=auto）；显式 `scope=global` 取全局并覆盖会话层同名（标记 covered）

## 运行时

内核服务使用**托管 Python**，不依赖、不修改系统 Python：

1. 首次调用内核工具时，从 `python/runtime.json` 清单惰性引导
2. 下载固定版本 uv（官方 .sha256 校验）→ `uv python install 3.13` → 建 venv → 装依赖（ipython/numpy/pandas/pyarrow）
3. 缓存于 `$PI_KERNEL_CACHE` 或 `~/.cache/pi-ipython-kernel/`，之后秒级复用；清单变化自动重建
4. 引导失败自动降级系统 python3 并提示一次

升 Python 版本只改 `runtime.json`，不重新发包。

## 安装与启用

**作为工作区插件**（本地路径）：
```bash
pi install . -l        # 在当前仓库目录
# 或把仓库 clone 到任意位置后：pi install /path/to/pi-ipython-kernel -l
```

**作为 Git 包**（已推送到 GitHub）：
```bash
pi install git:github.com/caikiji/pi-ipython-kernel@main -l
```

启用后 `/reload` 或新开会话，4 个工具即出现在工具列表。

## 开发

```bash
npm test               # Python (unittest) + Node (原生 type stripping)，零依赖可跑
tsc --noEmit           # 类型检查（需一次 npm install 提供 @earendil-works/* 类型）
```

```
extensions/kernel.ts   # 工具注册 + 生命周期（薄层）
src/                   # 纯 Node 逻辑：rpc / kernelProcess / format / runtime
python/server.py       # 内核服务：stdin/stdout JSON-RPC
python/storage.py      # 全局层：序列化 + SQLite
tests/                 # tests/python/*.py + tests/*.test.mjs
```

规则见 `RULES.md`（架构约束、提交规范、测试要求；由用户维护，agent 不得自行修改）。

## 状态

- [x] M0 骨架
- [x] M1 kernel_run（exec 引擎 + 差异报告 + 中断语义）
- [x] M2 kernel_ls/get/publish + SQLite 全局层（跨会话持久化）
- [x] M4 托管运行时引导（uv + python-build-standalone）
- [ ] M3/M5 执行器升级（IPython 引擎接入）、重放层（init 脚本注册）、文档补全
