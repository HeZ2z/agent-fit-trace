# agent-fit-trace

由 Agent 驱动的训练记录与教练应用，根据训练日志提供有据可查的进度分析和训练计划草案。

[English](README.md) | [简体中文](README.zh-CN.md)

## 状态

当前已实现 Web App、确定性共享核心、本地与认证 HTTP 数据访问、包含 Extension 工具和 `training-coach` Skill 的 pi 集成，以及完整的教练流程：`agent-fit-trace start` 启动器在同一源上提供 App 与回环教练服务器，认证 HTTP 部署也会显示 Coach 界面。由账户级 owner 统一驱动会话、流式运行、取消/重连、后端选择，以及带版本、绑定账户的恢复。本地 pi 仍是默认且兼容旧客户端的路径；`piAvailable: false` 会在界面中明确提示，而不是笼统的失败。本地运行会写入应用自有 journal，使保留的 run、事件和幂等记录在启动器重启后仍可恢复；若上一进程退出时仍有 active run，会标记为执行状态未确认，而不是静默重跑。

实验性的 Agent 路径已经实现，但都由 fail-closed 门控：当已安装的 Codex CLI 暴露 `item/tool/call` 流程时，本地 Codex 可在只读沙箱（read-only sandbox）姿态下运行（[ADR 0007](docs/adr/0007-read-only-sandbox-is-not-isolation.md)）——写入与网络被禁止，但模型仍可读取操作系统账户可读的文件并将其回显到对话记录中，因此 `builtinIsolationVerified` 保持为 false；本地 OpenCode 只有在已安装 CLI 提供正向的工具隔离证据时才可用。托管云端教练已有服务端路由、数据库迁移、outbox worker、有限配额预留和有界 provider 调用循环，但仅在正式账户、已配置配额、provider 与显式运维配置齐备时启用；本仓库尚未部署，也未用真实 provider 验证。

## 工作方式

App JSON → `import_workout` → 确定性分析 → `generate_next_plan` 草案 → 用户确认。

- **App** — `app/`：训练记录录入、历史查询、分析与计划草案展示。
- **共享核心** — `packages/fit-trace-core/`：确定性校验、指标计算、进度分析与计划草案。
- **数据 API** — `packages/fit-trace-api-contracts/` 和 `server/`：共享客户端契约与认证 HTTP 数据访问。
- **现有 pi 集成** — `.pi/extensions/fit-trace/` 和 `.pi/skills/training-coach/SKILL.md`：工具注册、共享的按身份隔离的 SQLite 存储（JSON 仍可作为为期一个版本的兼容逃生通道）与教练行为指令。

## MCP 服务器

`packages/fit-trace-mcp/` 通过 Model Context Protocol（stdio）暴露与 pi 扩展相同的四个工具，外加两个只读资源和 `training-coach` prompt，任何 MCP 宿主都可以基于同一份按身份隔离的共享 SQLite 存储工作。存储、宿主配置与验证方式见 [docs/mcp.md](docs/mcp.md)。

## 桌面壳

`pnpm desktop:dev` 在 Electron 窗口中打开 App，窗口背后是它自己拉起的本地 daemon——一条命令、一份数据、零自定义 IPC。本地构建请运行 `FIT_TRACE_DESKTOP_CHANNEL=guest-only pnpm desktop:build && pnpm desktop:package`（release 渠道构建需配置公开认证变量，见 [docs/release.md](docs/release.md)）。该命令产出**未签名的内部构建**（不签名、不公证、无自动更新）。打包版会随附打包后的 pi 扩展 `pi-extension.mjs`，但不会随附任何 Agent CLI，因此本地教练功能需要用户安装对应的 CLI——pi 后端需要 `pi`（以及随附的扩展），Codex 后端需要 `codex`（ADR 0007）；OpenCode 仍需工具隔离证据。训练记录与应用外壳在不安装任一 CLI 时也始终可用。详见 [docs/local-daemon.md](docs/local-daemon.md) 与 [docs/release.md](docs/release.md)。

## 开发

需要 Node >= 24 和 pnpm。

```bash
pnpm install
pnpm test
pnpm typecheck
```

## 文档

- [PR 提交规范](CONTRIBUTING.md)
- [MVP 设计](docs/mvp-design.md)
- [pi 集成规范](docs/extension-skill-spec.md)
- [本地 daemon 与桌面壳](docs/local-daemon.md)
- [MCP 服务器](docs/mcp.md)
