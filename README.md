# pi-ipython-kernel

给 pi agent 一个**可跨上下文持久化的 Python 工作内核**：`kernel_run` 执行代码并让变量存活，`kernel_publish` 把结果发布到工作区全局层，任何后续会话用 `kernel_get` 取回。简单说——把 agent 的"工作记忆"从易失的上下文窗口搬到持久的内核里。

```
会话 A: kernel_run 定义 df → kernel_publish df
会话 B: kernel_ls 发现 df → kernel_get 取回 → kernel_run 直接用
```

## 五个工具

| 工具 | 频率 | 作用 |
|---|---|---|
| `kernel_run(code, timeout?)` | 高频 | 在持久内核里执行 Python，返回输出 + 命名空间差异（new/changed/removed） |
| `kernel_ls(scope?, pattern?, detail?)` | 会话开场 | 列出注册函数/数据（REGISTERED，来自 init 脚本）+ 会话层变量 + 全局层对象（含版本/大小/过期标记） |
| `kernel_get(name, summarize?, scope?, force?)` | 取结果 | 取对象摘要（或全量），全局对象自动注入会话命名空间 |
| `kernel_publish(name, description, source?, expected_version?)` | 交接 | 发布会话对象到全局层，强制描述，可带源文件做过期校验 |
| `kernel_delete(name, expected_version?)` | 清理 | 删除全局层对象，幂等（不存在不报错），可带版本乐观锁；会话变量不受影响 |

设计原则：**低频功能降级为参数，不升格为工具**——validate/describe/load/status 全部内嵌在 ls/get 的行为里；delete 是 publish 的对称生命周期操作，与发布同等地位，故独立成工具。

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

- **三层状态**：代码/函数走重放（init 脚本注册），数据走快照（SQLite 带元数据），会话走即弃
- **SQLite 就是锁**：事务原子性 + WAL 读写并发 + 崩溃恢复由存储引擎提供，不手写文件锁；多会话并发 publish 安全（last-write-wins + 覆盖提示，可选 `expected_version` 乐观锁）
- **安全序列化**：只接受白名单类型（str/int/float/bool/None/bytes/datetime/list/dict + numpy 标量与数组 + pandas/polars DataFrame/Series），JSON 兜底 / npy / parquet 编码，**不做 pickle/cloudpickle 任意代码执行通道**；其他类型发布时拒绝并提示"导出为文件"
- **快照过期**：publish 时可声明 `source=<文件>`，记录源文件 hash；源文件变化后 ls/get 标记 INVALID 并给出重建建议，不静默返回旧数据（`force=true` 可显式取回）
- **读永远新鲜**：会话进程不缓存全局层对象，任何事务提交后立即可见
- **Shadow 语义**：会话层与全局层同名对象，会话层优先（scope=auto）；显式 `scope=global` 取全局并覆盖会话层同名（标记 covered）

### 注册机制（代码走重放）

项目级常用函数/数据写在 init 脚本里，每次会话启动自动执行进内核，`kernel_ls` 的 REGISTERED 区展示签名与描述，agent 用 `kernel_run` 直接调用——不写重量级扩展，也不重复粘贴代码：

```python
# .kernel/init.py（本机，gitignored）或 kernel_init.py（项目根，可提交）
def load_sales(path="sales.csv"):
    """Load the sales CSV as a DataFrame."""
    return pd.read_csv(path)

register("load_sales", load_sales, "Load sales data as DataFrame.")   # 显式
@register("clean_df", "Cleaned data ready for modeling.")             # 装饰器（第二个位置参数即描述，缺省取 docstring 首行）
def clean_df(df): ...
register("raw_df", pd.read_csv("sales.csv"), "Raw sales data.")        # 纯数据也可注册
```

- 签名（参数/默认值/返回标注）与数据摘要（df 给 shape/columns）自动提取；同名重复注册 = 覆盖（last-write-wins），运行输出会给出覆盖提示（`register: overwrote existing entry ...`）
- 装饰器形式第二个位置参数就是描述（`@register("name", "desc")`，也可用 `description=`）；**注册纯字符串数据请用显式形式**（`register("name", obj="...", description="...")` 或三参）——裸字符串位置参数会被当作描述
- `unregister(name)` 幂等注销：从 REGISTERED 区与（未被重新赋值的）会话变量中移除；仅当前会话生效，init 脚本在下个会话重新注册
- 注册名同时是普通会话变量，`kernel_run` 可直接引用；`register` 在 `kernel_run` 里也可用，但仅当前会话有效——**跨会话注册的唯一途径是 init 脚本**
- 修改 init 脚本**热重载**：保存后下一次内核调用（任意工具）自动重新执行脚本并返回摘要（`[init] reloaded ...: +1 registered (foo), -1 vars (bar)`）；旧脚本注册过但新脚本删掉的名字自动注销、脚本变量同步清理（agent 后来改过的值保留）；重载失败则回滚，会话保持原样
- **安全**：init 脚本是"每次会话自动执行的项目代码"，本身不扩大内核权限（agent 本就有 `kernel_run` 任意执行权），但变更不可见；本扩展按内容 hash 跨会话检测，脚本新增/变化时在会话开头提示一次（状态存缓存目录，不落工作区）；`kernel_init.py` 提交前请自行审阅，只从可信来源 pull
## 运行时

内核服务使用**托管 Python**，不依赖、不修改系统 Python：

1. 首次调用内核工具时，从 `python/runtime.json` 清单惰性引导
2. 下载固定版本 uv（官方 .sha256 校验，带超时与重试）→ `uv python install 3.13` → 建 venv → 装依赖（ipython/numpy/pandas/pyarrow）
3. 缓存于 `$PI_KERNEL_CACHE` 或 `~/.cache/pi-ipython-kernel/`，之后秒级复用；清单变化自动重建
4. 引导失败自动降级系统 Python（POSIX 找 `python3`，Windows 找 `python`）并提示一次
5. 需要新包时用托管 uv 装进托管 venv：`~/.cache/pi-ipython-kernel/uv/uv pip install --python ~/.cache/pi-ipython-kernel/venv/bin/python <pkg>`（路径由 `$PI_KERNEL_CACHE` 可覆盖），装完当前会话即可 import

**复用本地 Python（跳过全部下载）**：设置环境变量 `PI_KERNEL_PYTHON=<解释器路径>`（如 `C:\miniconda\python.exe` 或 `/usr/bin/python3`）后，内核直接使用该解释器，不再下载 uv/Python/依赖。IPython 可选——没有时自动降级为标准库 exec 引擎（零依赖可跑）；pandas/numpy 由你本地环境决定。

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

> **全局安装与开发迭代**：插件以 `git:...` 全局安装时，项目内 /reload 后加载的是
> 全局 clone（`~/.pi/agent/git/...`）的 main 快照，**不是本地工作区代码**。开发流程：
>
> 1. 本地改代码 → `npm test` + 模拟加载验证
> 2. `git push` 推送到 main
> 3. `pi update --extensions` 刷新全局 clone 到最新提交（或 `pi install git:github.com/caikiji/pi-ipython-kernel@main` 重装）
> 4. `/reload` 生效
>
> 想在项目内临时用本地代码：`pi -e ./extensions/kernel.ts`（命令行临时扩展，覆盖全局）。
> 注意不要同时在全局和项目里安装同一包的不同身份（git URL vs 本地路径）——身份不同不去重，
> 会双加载、同名工具行为不确定。

## MCP 模式（兼容任意 harness）

同一套内核还以 **MCP 服务器** 形态提供，Claude Desktop / Cursor 等任意支持 MCP 的客户端都能用：

```
node mcp/server.ts        # Node ≥ 23.6；22.18+ 加 --experimental-strip-types
```

- **工作区 = 服务器进程的 cwd**：`.kernel/` 全局层与 init 脚本（kernel_init.py）都取自 cwd，与 pi 插件语义一致
- **工具**：kernel_run / kernel_ls / kernel_get / kernel_publish / kernel_delete（与 pi 插件同名同参数同输出格式）
- **资源**：`kernel://registry` 暴露 init 脚本注册表摘要（对应 pi 插件的 before_agent_start 注入，MCP 里由 agent 按需读取）
- 托管运行时引导、超时中断、SQLite 全局层、重放层全部复用，零改动

Claude Desktop（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "kernel": {
      "command": "node",
      "args": ["C:/Users/<you>/.pi/agent/git/github.com/caikiji/pi-ipython-kernel/mcp/server.ts"],
      "cwd": "D:/path/to/your/workspace"
    }
  }
}
```

首次调用会触发托管运行时引导（约 1-2 分钟，之后缓存）；不想下载就在 `env` 里设 `PI_KERNEL_PYTHON` 复用本地 Python。
## 开发

```bash
npm test               # Python (unittest) + Node (原生 type stripping)，零依赖可跑
tsc --noEmit           # 类型检查（需一次 npm install 提供 @earendil-works/* 类型）
```

```
extensions/kernel.ts   # pi 插件：工具注册 + 生命周期（薄层）
mcp/server.ts          # MCP 服务器入口（同内核，兼容任意 harness）
src/                   # 纯 Node 逻辑：rpc / kernelProcess / format / runtime / mcp
python/server.py       # 内核服务：stdin/stdout JSON-RPC
python/storage.py      # 全局层：序列化 + SQLite
tests/                 # tests/python/*.py + tests/*.test.mjs
```

规则见 `RULES.md`（架构约束、提交规范、测试要求；由用户维护，agent 不得自行修改）。

## 状态

- [x] M0 骨架
- [x] M1 kernel_run（exec 引擎 + 差异报告 + 中断语义）
- [x] M2 kernel_ls/get/publish + SQLite 全局层（跨会话持久化）
- [x] M5 kernel_delete：全局层删除（幂等 + 版本乐观锁 + 删除后版本重置 v1）
- [x] M4 托管运行时引导（uv + python-build-standalone）
- [x] IPython 引擎接入（magics/rich repr，ANSI 清理 + 保留名过滤）
- [x] 重放层：工作区 init 脚本（.kernel/init.py / kernel_init.py）启动时自动执行
- [x] 托管运行时真实下载验证（首次调用完成引导，engine=ipython 确认）
- [x] 验收测试：26 项检查通过（25 项一次通过，1 项修正 fixture 后通过），跨会话闭环验证完成
