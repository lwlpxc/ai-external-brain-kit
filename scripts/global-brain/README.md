# 全局大脑部署备份（2026-10-21）

外置大脑的"全局层"长在系统用户目录里（不进任何 git 仓库），哪台机器要重装/换机，从这里恢复。工作流真本不用从这里恢复——它在 `scripts/zcode-digest/`，随 git 双机同步。

## 备份了什么

| 文件 | 原始位置（每台机器各自部署） | 作用 |
|---|---|---|
| `brain-SKILL.md` | `~/.zcode/skills/brain/SKILL.md` | 全局技能：任何项目的对话自动记大脑/先查再答 |
| `AGENTS-外置大脑节.md` | `~/.zcode/AGENTS.md` 的「## 5. 外置大脑」 | 全局规则里的一小节，让所有会话知道大脑存在 |

## 恢复三步（新机器或重装后）

1. 建目录 `~/.zcode/skills/brain/`，把 `brain-SKILL.md` 复制进去改名为 `SKILL.md`；
2. 把 `AGENTS-外置大脑节.md` 的内容追加到 `~/.zcode/AGENTS.md` 末尾（已存在同节就不用重复加）；
3. 恢复定时任务（见下），再确认 `scripts/zcode-digest/` 在本机存在（git clone 本仓库即可）。

## 定时任务定义（ZCode 里重建：让我「按下面的定义建定时」即可）

- **每天 17:40 ZCode对话日结**（cron `40 17 * * *`）：调用 CreateWorkflow 以 path 方式跑 `scripts/zcode-digest/zcode-daily-digest.workflow.ts`（不传 args）；失败退 saved 方式（名称 zcode-daily-digest）。工作流会查漏总结当天项目B/项目A对话、提交当天实时即记并推送。
- 另有 18:00 自动制卡、次日 8:10 晨间复习两个任务（定义见各自的自动化设置，与本备份无依赖关系）。

## 依赖说明

- 会话数据库在每台机器各自的 `~/.zcode/cli/db/db.sqlite`——哪台机器跑定时，就总结哪台机器上的对话；水位在 `scripts/zcode-digest/local-state/`（已 gitignore，本机独立）。
- 家用机没有工作项目对话时，17:40 的运行会自然空转（不报错、不丢水位）。
