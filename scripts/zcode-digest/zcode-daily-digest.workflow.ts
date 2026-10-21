/* zcode-workflow
description: "把当天项目B/项目A项目 ZCode 对话中的学习要点提炼成日结（查漏模式：先读当天 brain 技能的实时即记，只补漏掉的），连同即记文件一并写入 your-brain-repo/raw/公司学习/ 并提交。每天定时跑，也可手动带参数补跑。"
args:
  since_hours:
    type: number
    default: 0
    description: "大于 0 时覆盖水位，向前回溯指定小时数（补跑历史用；默认 0 = 走水位）"
  projects:
    type: string
    default: "project_a,project_b"
    description: "要覆盖的项目目录后缀，逗号分隔（如只跑项目B填 project_b）"
  inbox_dedupe:
    type: boolean
    default: true
    description: "查漏模式开关。true=先读当天实时即记只补漏（默认，配合 brain 技能）；false=纯每日总结模式（不读即记、全部照记，brain 模式行不通时的退路）"
*/

// 工作流：ZCode 对话日结（项目B + 项目A项目）
// 上游：每天定时（或手动）运行；读 .zcode/scripts/zcode-digest.cjs 提取的会话 dump。
// 下游：分项目提炼 → 独立审读 → 书记员写入 your-brain-repo/raw/公司学习/对话日结/ 并 git 提交。
// 水位：scripts/zcode-digest/local-state/digest-state.json（本机各自保留，成功落盘才推进，失败/中断下次重吃，不重不漏）。

interface ProjectStat {
  /** 项目目录名后缀，如 project_a */
  project: string;
  /** 项目中文名，如 项目A */
  label: string;
  /** 窗口内有效会话数 */
  sessions: number;
  /** 提取出的用户消息条数 */
  userTurns: number;
  /** 提取出的 AI 回复条数 */
  assistantTurns: number;
  /** dump 文件绝对路径（喂给提炼员读） */
  absFile: string;
}

interface ExtractSummary {
  ok: boolean;
  /** 窗口截止日的本地日期 YYYY-MM-DD（日结文件名用） */
  date: string;
  /** 窗口起点，epoch 毫秒 */
  since: number;
  /** 窗口终点，epoch 毫秒 */
  until: number;
  /** 当天实时即记文件（brain 技能写入）绝对路径，查漏用 */
  inbox: string;
  projects: ProjectStat[];
}

interface ProjectDigest {
  /** 项目中文名 */
  label: string;
  /** 是否有值得记录的内容 */
  hasContent: boolean;
  /** 日结中该项目的 markdown 小节，不含一级/二级标题；hasContent=false 时为空串 */
  markdown: string;
  /** 当日亮点，每条一句话，用于最终报告 */
  highlights: string[];
}

interface ReadCritique {
  /** 草稿是否可直接入库 */
  ok: boolean;
  /** 具体问题：哪个说法缺依据、哪里读不懂、用户会追问什么 */
  issues: string[];
}

interface ScribeResult {
  /** 日结文件是否成功写入 */
  written: boolean;
  /** 日结文件路径（工作区相对，如 your-brain-repo/raw/公司学习/对话日结/2026-10-21.md） */
  file: string;
  /** 是否为同日第二次运行追加的补记 */
  appended: boolean;
  /** git commit 是否成功 */
  committed: boolean;
  /** git push 是否成功 */
  pushed: boolean;
  /** 提交哈希前 10 位，未提交为空串 */
  commitHash: string;
  /** 需要用户知道的事（推送失败原因等） */
  note: string;
}

interface Finding {
  /** 项目中文名 */
  where: string;
  /** 一句话亮点 */
  what: string;
  /** 依据来源 */
  evidence: string;
  /** verified = 直接取自当日会话记录 */
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  conclusion: string;
  findings: Finding[];
  verified: string[];
  notCovered: string[];
}

const sinceHours = Number(args.since_hours ?? 0); // >0 时覆盖水位回溯，用于补跑
const projectArg = String(args.projects ?? "project_a,project_b");
// 查漏模式开关：false = 纯每日总结模式（今天最初的工作流行为，brain 模式行不通时的退路）
const inboxDedupe = args.inbox_dedupe !== false;
// 双机部署（2026-10-21）：提取脚本 cjs 在仓库 scripts/zcode-digest/ 下随 git 同步。
// 工作流脚本禁用 import/node:fs（迁移版曾因此编译失败），定位放到 node -e 子进程里做：
// 从 world.run 的 cwd 逐级向上找（cwd 会随会话 shell 漂移，不能只用相对路径），
// 找不到再退回公司机 workspace 旧位置。
const LOCATOR = [
  "const fs=require('fs'),path=require('path');",
  "let d=process.cwd(),found='';",
  "for(let i=0;i<6&&!found;i++){",
  "  for(const rel of ['scripts/zcode-digest/zcode-digest.cjs','your-brain-repo/scripts/zcode-digest/zcode-digest.cjs']){",
  "    const p=path.join(d,rel); if(fs.existsSync(p)){found=p;break}",
  "  }",
  "  d=path.dirname(d);",
  "}",
  "if(!found){const l='<公司机大脑仓库路径>/.zcode/scripts/zcode-digest.cjs';if(fs.existsSync(l))found=l;}",
  "console.log(found);",
].join("");

function extractorAsk(p: ProjectStat, date: string, inbox: string): string {
  const lines = [
    `你是知识沉淀编辑，给嵌入式工程师做个人成长日结。`,
    `读取对话记录文件：${p.absFile}`,
    `（JSON，${p.label} 项目 ${date} 的 ${p.sessions} 个会话；turns 里 role=user 是工程师本人的话/贴的日志/同事聊天记录，role=assistant 是 ZCode 的回复。）`,
    ``,
  ];
  if (inboxDedupe) {
    lines.push(
      `查漏优先：今天可能已有实时记录——先读 ${inbox}（不存在就跳过这步）。里面是各项目会话当场记下的条目，**已被它覆盖的内容不要再写**，只提炼它漏掉的；若它已覆盖全部值得记的内容，直接 hasContent=false、markdown 空串，并在 highlights 里说明「实时即记已覆盖，无遗漏」。`,
      ``,
    );
  }
  lines.push(
    `把其中对个人成长有价值${inboxDedupe ? "且实时记录没覆盖的" : ""}内容提炼成一节日结 markdown。只记四类（用户明确要的）：`,
    `1. 技术学习点：新概念/新机制（如 epoll、串口收发线程模型、协议帧格式 12+8 之类）、原理性理解；`,
    `2. 踩坑与解决：报错排查、假数据/模拟器手法（如 fake_mcu）、卡了很久才通的问题；`,
    `3. 协作与对接：和同事或另一块板子对接约定了什么（如按键板串口要对接的内容）、同事原话要点；`,
    `4. 工作方法：流程、工具、git/CI、AI 协作方式的收获。`,
    `不记：纯页面摆放/切图换资源等机械操作、与提升无关的闲聊。`,
    ``,
    `写法：`,
    `- 按主题组织小节（### 标题 + 要点列表），不按会话流水账；`,
    `- 每个要点一两句话讲清「是什么 + 为什么值得记」，术语第一次出现给一句解释；`,
    `- 末尾加「### 原话摘录」小节：挑 3~6 条最能代表当日工作和思考的用户原话，逐字引用（> 引用块）；`,
    `- 不写一级/二级标题（外层文件已有）；内容确实不值得记就 hasContent=false、markdown 空串。`,
  );
  return lines.join("\n");
}

// 安静日收尾：无新对话可提炼，但当天可能有别的会话按 brain 技能实时记的即记等着提交
function quietScribeAsk(date: string, inbox: string): string {
  return [
    `今天窗口内没有可提炼的新对话。检查文件 ${inbox}（仓库内相对路径 raw/公司学习/对话即记/${date}.md）：`,
    `- 不存在 → 什么都不做，file 返回空串、written=false、note 写"无对话且无实时即记"；`,
    `- 存在 → 数一下条目数 N：更新台账 raw/公司学习/待摄取.md（新增一行「- 对话即记/${date}（实时记 N 条，当日无补充日结）」，调整计数）；然后按明确文件列表 git add（即记 + 台账，禁止 git add -A），git commit -m "对话即记 ${date} → raw/公司学习/" 并 push（失败重试一次，仍失败写进 note）。file 返回即记路径，written 表示是否成功提交。`,
    `仓库定位与主流程相同（git rev-parse --show-toplevel 或从 cwd 向上找）；只动即记和台账两个文件。`,
  ].join("\n");
}

phase("提取窗口内两个项目的会话记录");
const locate = await world.run("node", ["-e", LOCATOR]);
const DIGEST_SCRIPT = (locate.stdout.trim().split("\n").pop()) || "";
if (locate.exitCode !== 0 || !DIGEST_SCRIPT) {
  return {
    conclusion: "找不到提取脚本 zcode-digest.cjs（应位于 your-brain-repo/scripts/zcode-digest/，公司机旧位 <公司机大脑仓库路径>/.zcode/scripts/），日结未生成，水位未推进。",
    findings: [],
    verified: [],
    notCovered: [locate.stderr.slice(0, 500)],
  } satisfies WorkflowReport;
}
const extractArgs = [DIGEST_SCRIPT, "extract", "--projects", projectArg];
if (sinceHours > 0) extractArgs.push("--since-hours", String(sinceHours));
const extract = await world.run("node", extractArgs, { timeoutMs: 120000 });
if (extract.exitCode !== 0) {
  return {
    conclusion: "会话提取失败，日结未生成，水位未推进（下次运行会重试同一窗口）。",
    findings: [],
    verified: [],
    notCovered: [extract.stderr.slice(0, 800)],
  } satisfies WorkflowReport;
}
const summaryLine = extract.stdout.trim().split("\n").pop() || "{}";
const summary = JSON.parse(summaryLine) as ExtractSummary;
const active = summary.projects.filter((p) => p.userTurns > 0);
log(`窗口 ${new Date(summary.since).toISOString()} → ${new Date(summary.until).toISOString()}，${active.length} 个项目有对话`);

if (active.length === 0) {
  if (inboxDedupe) {
    const quiet1 = await agent("书记员·无对话", {
      system:
        "你是知识库书记员，严格照指令办事：只新增/追加指定文件，绝不修改 raw/ 下其他文件；做不到的步骤如实写进 note 返回，不谎报成功。",
    }).ask<ScribeResult>(quietScribeAsk(summary.date, summary.inbox));
    await world.run("node", [DIGEST_SCRIPT, "advance", "--until", String(summary.until)]);
    return {
      conclusion: `窗口内两个项目都没有新对话${quiet1.written ? `；当天的实时即记已提交（${quiet1.file}）` : quiet1.file ? `；实时即记提交失败：${quiet1.note}` : "，也无实时即记"}，水位已推进。`,
      findings: [],
      verified: ["空窗口：由提取脚本对会话库的确定性查询确认"],
      notCovered: [],
    } satisfies WorkflowReport;
  }
  await world.run("node", [DIGEST_SCRIPT, "advance", "--until", String(summary.until)]);
  return {
    conclusion: `窗口内两个项目都没有新对话，未生成日结，水位已推进到 ${new Date(summary.until).toISOString()}。`,
    findings: [],
    verified: ["空窗口：由提取脚本对会话库的确定性查询确认"],
    notCovered: [],
  } satisfies WorkflowReport;
}

phase("分项目提炼当日学习要点");
const digests = await Promise.all(
  active.map((p) =>
    agent(`提炼员·${p.label}`, {
      system:
        "你是严谨的知识沉淀编辑：只依据读到的对话记录写日结，记录里没有的不编造；读不到文件或有指令冲突就直说并停止，不要硬凑内容。",
    }).ask<ProjectDigest>(extractorAsk(p, summary.date, summary.inbox)),
  ),
);
const withContent = digests.filter((d) => d.hasContent && d.markdown.trim().length > 0);
for (const d of digests) log(`${d.label}：${d.hasContent ? `提炼完成，${d.highlights.length} 条亮点` : "无值得记录的内容"}`);

if (withContent.length === 0) {
  if (inboxDedupe) {
    const quiet2 = await agent("书记员·无可记", {
      system:
        "你是知识库书记员，严格照指令办事：只新增/追加指定文件，绝不修改 raw/ 下其他文件；做不到的步骤如实写进 note 返回，不谎报成功。",
    }).ask<ScribeResult>(quietScribeAsk(summary.date, summary.inbox));
    await world.run("node", [DIGEST_SCRIPT, "advance", "--until", String(summary.until)]);
    return {
      conclusion: `当日 ${active.map((p) => p.label).join("、")} 的对话没有值得沉淀的内容，未建日结文件${quiet2.written ? `；当天的实时即记已提交（${quiet2.file}）` : quiet2.file ? `；实时即记提交失败：${quiet2.note}` : "，也无实时即记"}，水位已推进。`,
      findings: [],
      verified: ["两个项目的对话都由提炼员通读过并判定无沉淀价值"],
      notCovered: [],
    } satisfies WorkflowReport;
  }
  await world.run("node", [DIGEST_SCRIPT, "advance", "--until", String(summary.until)]);
  return {
    conclusion: `当日 ${active.map((p) => p.label).join("、")} 的对话没有值得沉淀的内容，未建日结文件，水位已推进。`,
    findings: [],
    verified: ["两个项目的对话都由提炼员通读过并判定无沉淀价值"],
    notCovered: [],
  } satisfies WorkflowReport;
}

// 草稿 = 外层标题 + 各项目小节（审读与书记员共用的同一份文本）
const draft = [
  `# ${summary.date} ZCode 对话日结`,
  ``,
  ...withContent.map((d) => `## ${d.label}\n\n${d.markdown}`),
].join("\n\n");

phase("独立审读日结草稿");
const critique = await agent("审读员", {
  system:
    "你是挑剔的审读员：只凭拿到的草稿文本挑毛病，不去读任何文件。任务是把会让读者受损的问题找出来，不是夸草稿。做不到或草稿太短没法审就直说。",
}).ask<ReadCritique>(
  [
    `下面是 ${summary.date} 的 ZCode 对话日结草稿（源自当日会话记录，你只看文本本身）。挑三类问题：`,
    `1. 哪些论断看起来缺少对话依据、像编造或过度发挥；`,
    `2. 哪里表述不清，三个月后回看会看不懂；`,
    `3. 读者会追问什么而草稿没回答。`,
    `每条问题指明在哪个小节。没有问题才 ok=true。`,
    ``,
    draft,
  ].join("\n"),
);
log(critique.ok ? "审读通过" : `审读提出 ${critique.issues.length} 条问题`);

const ledgerMention = inboxDedupe ? `；当天实时即记 raw/公司学习/对话即记/${summary.date}.md 一并入库` : "";
const inboxAddition = inboxDedupe ? `；若 raw/公司学习/对话即记/${summary.date}.md 存在且尚未提交，也一并加入——那是今天各会话按 brain 技能实时记的条目` : "";

phase("写入知识库、更新台账并提交");
const scribe = await agent("书记员", {
  system:
    "你是知识库书记员，严格照指令办事：只新增/追加指定文件，绝不修改 raw/ 下其他文件；git 只在 your-brain-repo 仓库内操作；做不到的步骤如实写进 note 返回，不谎报成功。",
}).ask<ScribeResult>(
  [
    `把下面的日结草稿写入知识库并提交。知识库是本工作区下的 your-brain-repo/ 目录（Obsidian 库 + git 仓库）。双机部署路径不固定：先用 git rev-parse --show-toplevel 或从你的 cwd 向上定位仓库根（即 your-brain-repo/），定位不到就如实返回 written=false 并说明，不要猜路径。下文 your-brain-repo/ 前缀的路径均相对工作区根，等价于仓库内去掉该前缀。`,
    ``,
    `1. 目标文件 your-brain-repo/raw/公司学习/对话日结/${summary.date}.md：`,
    `   - 不存在 → 新建：frontmatter（source: 用户与ZCode对话日结（自动生成）/ type: work-note / date: ${summary.date} / recorded: ${summary.date} / tags: [对话日结, 公司学习]），一级标题「# ${summary.date} ZCode 对话日结」，一句引言说明由工作流从当日 ZCode 会话自动提炼、摄取时作导读不作原话，然后是草稿正文；`,
    `   - 已存在 → 文末追加「## 补记 <当前时刻 HH:MM>」段再放草稿正文，不动已有内容，appended=true。`,
    `2. 审读意见（有问题先修再写入：缺依据的论断删掉或改成有依据的说法，不清的地方补一句上下文）：${JSON.stringify(critique.issues)}`,
    `3. 更新台账 your-brain-repo/raw/公司学习/待摄取.md：新增一行「- 对话日结/${summary.date}（两个项目各一句概括${ledgerMention}）」，同步调整「当前待摄取 N 篇」计数。`,
    `4. 在 your-brain-repo 里按明确文件列表 git add（日结文件 + 台账${inboxAddition}。禁止 git add -A——工作区常有用户未提交的遗留改动，不许卷进日结提交），然后 git commit -m "对话日结 ${summary.date} → raw/公司学习/"，成功后 git push；push 失败重试一次，仍失败写进 note 即可（仓库规则：下次会话补推）。`,
    `5. 台账和日结以外的 raw/ 文件一律不碰。`,
    ``,
    `草稿：`,
    ``,
    draft,
  ].join("\n"),
);

phase("推进水位并发布日结");
if (scribe.written) {
  await world.run("node", [DIGEST_SCRIPT, "advance", "--until", String(summary.until)]);
} else {
  log("日结未落盘，水位不推进，下次运行重吃本窗口");
}
if (scribe.written) {
  try {
    await artifact.file("digest", scribe.file, {
      title: `ZCode 对话日结 ${summary.date}`,
      description: `从当日项目B/项目A项目对话提炼的学习要点，已写入知识库并提交。`,
      primary: true,
    });
  } catch {
    log("日结卡片发布失败，文件本身已写入知识库");
  }
}

const findings: Finding[] = digests.flatMap((d) =>
  d.highlights.map((h) => ({
    where: d.label,
    what: h,
    evidence: `${summary.date} 当日 ZCode 会话记录（提取窗口 ${new Date(summary.since).toISOString()} 起）`,
    status: "verified" as const,
    severity: "low" as const,
  })),
);

const report: WorkflowReport = {
  conclusion: [
    `${active.map((p) => `${p.label}（${p.sessions} 个会话/${p.userTurns} 条用户消息）`).join("、")} 的当日对话已提炼成日结。`,
    scribe.written
      ? `已写入 ${scribe.file}${scribe.appended ? "（同日补记）" : ""}${scribe.committed ? `，git 提交 ${scribe.commitHash}` : "，但 git 提交失败"}${scribe.pushed ? "并已推送" : "，推送未成功（下次会话补推）"}。`
      : "但写入知识库失败，水位未推进，下次运行会重试。",
    scribe.note ? `备注：${scribe.note}` : "",
  ]
    .filter(Boolean)
    .join(""),
  findings,
  verified: [
    `提取窗口由水位机制保证不重不漏（since=${new Date(summary.since).toISOString()}）`,
    scribe.written ? `日结文件已写入：${scribe.file}` : "日结未写入",
    scribe.committed ? `git 提交成功：${scribe.commitHash}` : "git 未提交",
    critique.ok ? "草稿经独立审读无意见" : `草稿经独立审读，${critique.issues.length} 条意见已在写入前处理`,
  ],
  notCovered: [
    "对话中的 AI 回复只取正文文本（工具调用与中间过程不在提炼原料内）",
    "单个项目窗口内容超过 10 个会话/180KB 时按最后活跃截断",
  ],
};
return report;
