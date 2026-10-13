# agent-fit-trace

由 Agent 驱动的训练记录与教练应用，根据训练日志提供有据可查的进度分析和训练计划草案。

[English](README.md) | [简体中文](README.zh-CN.md)

## 状态

当前已实现 Web App、确定性共享核心、本地与认证 HTTP 数据访问、包含 Extension 工具和 `training-coach` Skill 的 pi 集成，以及本地、由启动器开关控制的教练流程：`agent-fit-trace start` 启动器在同一源上提供 App 与回环教练服务器，App 的 Coach 界面（仅在该运行时标志存在时显示）驱动会话、流式运行、取消/重连，以及带版本、绑定账户的恢复。教练通过用户本地的 pi CLI 运行；`piAvailable: false` 会在界面中明确提示，而不是笼统的失败。

计划支持的 Agent 能力：无需本地安装 Agent 的托管云端教练，以及通过用户已有的 Codex 或 OpenCode CLI 进行的本地教练。这些执行路径尚未实现。

## 工作方式

App JSON → `import_workout` → 确定性分析 → `generate_next_plan` 草案 → 用户确认。

- **App** — `app/`：训练记录录入、历史查询、分析与计划草案展示。
- **共享核心** — `packages/fit-trace-core/`：确定性校验、指标计算、进度分析与计划草案。
- **数据 API** — `packages/fit-trace-api-contracts/` 和 `server/`：共享客户端契约与认证 HTTP 数据访问。
- **现有 pi 集成** — `.pi/extensions/fit-trace/` 和 `.pi/skills/training-coach/SKILL.md`：工具注册、本地 JSON 持久化与教练行为指令。

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
