# @deepseek-ai/dsh-memory-staging-tools

[English](README.md) | 中文

Phase 2 Agent 的操作点限制。`MemoryStagingFileSystem` 拒绝绝对路径、路径逃逸、符号链接、替代 cwd、后端所有文件，以及对 `memory_summary.md`、`MEMORY.md` 和 `skills/**` 之外位置的写入。配套 `glob` 和 `grep` 只遍历该 Provider，不启动无限制子进程。

## 模型体验

### Phase 2 maintenance Session

#### 模型看到的内容

Scheduler 只装配 `read`、`write`、`edit`、`glob` 和 `grep`。搜索结果使用 staging 相对路径。

#### Token 影响

工具 schema 和选中的结果只进入私有 maintenance Session。

#### KV Cache 影响

Maintenance Session 与交互式请求缓存彼此独立。

## 已知限制和后续工作

- **ECMAScript grep 语法** — 私有 `grep` 使用 JavaScript 正则而不是 ripgrep 语法，确保搜索始终经过 rooted filesystem service。
