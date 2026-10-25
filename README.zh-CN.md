# agent-fit-trace

由 Agent 驱动的训练记录与教练应用，根据训练日志提供有据可查的进度分析和训练计划草案。

[English](README.md) | [简体中文](README.zh-CN.md)

## 状态

当前已实现 Web App、确定性共享核心、本地与认证 HTTP 数据访问、包含 Extension 工具和 `training-coach` Skill 的 pi 集成，以及完整的教练流程：`agent-fit-trace start` 启动器在同一源上提供 App 与回环教练服务器，认证 HTTP 部署也会显示 Coach 界面。由账户级 owner 统一驱动会话、流式运行、取消/重连、后端选择，以及带版本、绑定账户的恢复。本地 pi 仍是默认且兼容旧客户端的路径；`piAvailable: false` 会在界面中明确提示，而不是笼统的失败。本地运行会写入应用自有 journal，使保留的 run、事件和幂等记录在启动器重启后仍可恢复；若上一进程退出时仍有 active run，会标记为执行状态未确认，而不是静默重跑。

实验性的 Agent 路径已经实现，但都由 fail-closed 门控：本地 OpenCode 只有在已安装 CLI 提供正向的工具隔离证据时才可用；Codex 适配器在无法证明内置工具隔离前保持不可用。托管云端教练已有服务端路由、数据库迁移、outbox worker、有限配额预留和有界 provider 调用循环，但仅在正式账户、已配置配额、provider 与显式运维配置齐备时启用；本仓库尚未部署，也未用真实 provider 验证。

## 工作方式

App JSON → `import_workout` → 确定性分析 → `generate_next_plan` 草案 → 用户确认。

- **App** — `app/`：训练记录录入、历史查询、分析与计划草案展示。
- **共享核心** — `packages/fit-trace-core/`：确定性校验、指标计算、进度分析与计划草案。
- **数据 API** — `packages/fit-trace-api-contracts/` 和 `server/`：共享客户端契约与认证 HTTP 数据访问。
- **现有 pi 集成** — `.pi/extensions/fit-trace/` 和 `.pi/skills/training-coach/SKILL.md`：工具注册、本地 JSON 持久化与教练行为指令。

## MCP 服务器

`packages/fit-trace-mcp/` 通过 Model Context Protocol（stdio）暴露与 pi 扩展相同的四个工具，外加两个只读资源和 `training-coach` prompt，任何 MCP 宿主都可以基于同一份本地存储工作。存储、宿主配置与验证方式见 [docs/mcp.md](docs/mcp.md)。

## 桌面壳

`pnpm desktop:dev` 在 Electron 窗口中打开 App，窗口背后是它自己拉起的本地 daemon——一条命令、一份数据、零自定义 IPC（仅 dev 模式；见 [docs/local-daemon.md](docs/local-daemon.md)）。

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
