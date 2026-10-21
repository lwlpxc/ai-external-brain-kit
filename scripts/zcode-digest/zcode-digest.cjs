#!/usr/bin/env node
/**
 * zcode-digest.cjs — ZCode 对话日结的提取与水位工具
 *
 * 上游：被「zcode-daily-digest」动态工作流以 world.run("node", [...]) 调用。
 * 下游：读 ~/.zcode/cli/db/db.sqlite（ZCode 桌面版会话库），把项目B/项目A项目
 *       窗口内的用户/AI 正文文本抽成 JSON  dump，供提炼子代理阅读。
 *
 * 子命令：
 *   extract --outdir <dir> [--since <epoch-ms>] [--projects "project_a,project_b"]
 *       窗口 = (since 或 水位lastUntil 或 now-24h, now]。水位文件不存在且未给 since 时回溯 24h。
 *       输出 <outdir>/<project>.json；stdout 最后一行是 JSON 摘要（工作流解析用）。
 *   advance --until <epoch-ms>
 *       把水位推到 until（只在日结成功落盘后由工作流调用，失败不推进、下次重吃）。
 *
 * 双机部署（2026-10-21 迁入仓库）：脚本本身随 git 在公司机/家机间同步；
 * 水位与会话库是每台机器各自的——两机的 ZCode 会话库独立，水位若共享会让另一台
 * 机器的当日对话被跳过。local-state/ 与 tmp/ 已在仓库 .gitignore 排除，仅本机存在。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// 一律以脚本自身位置定位（不依赖进程 cwd——world.run 的 cwd 会跟随会话 shell 漂移，
// 吃过亏：2026-10-21 补跑相对路径解析到 your-brain-repo/ 下 MODULE_NOT_FOUND）。
// 会话库路径按机器用户目录解析，可用环境变量 ZCODE_DIGEST_DB 覆盖（非默认安装位置时）。
const DB_PATH = process.env.ZCODE_DIGEST_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const STATE_PATH = path.join(__dirname, 'local-state', 'digest-state.json');
// 仓库根（your-brain-repo）：提炼员查漏用的当天「对话即记」文件在 raw/公司学习/对话即记/ 下
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PROJECT_LABELS = {
  project_a: '项目A',
  project_b: '项目B',
};

// 用户角色下混入的系统/工具文本前缀（实测自 message/part 表），一律剔除
const NOISE_PREFIXES = [
  'The TodoWrite tool hasn\'',
  'This session was forked',
  'This session is being co',
  '<task-notification>',
  '<system-reminder>',
  '<untrusted_gen_ui_state>',
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<ide_selection>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<tool_use_error>',
  'Caveat:',
  '[Request interrupted',
  'Called the ',
  'A plan file exists from',
  'Available agent types',
];

const isNoise = (t) => NOISE_PREFIXES.some((p) => t.startsWith(p));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    out[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return out;
}

function localDateStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function extract() {
  const opts = parseArgs(process.argv.slice(3));
  const outdir = opts.outdir ? path.resolve(__dirname, opts.outdir) : path.join(__dirname, 'tmp', 'digest');
  const projects = String(opts.projects || Object.keys(PROJECT_LABELS).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const until = Date.now();
  const state = readState();
  // 优先级：--since > --since-hours > 水位 lastUntil > 回溯 24h
  const since = opts.since
    ? Number(opts.since)
    : (opts['since-hours']
        ? until - Number(opts['since-hours']) * 3600 * 1000
        : (state.lastUntil || until - 24 * 3600 * 1000));

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  fs.mkdirSync(outdir, { recursive: true });
  for (const f of fs.readdirSync(outdir)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(outdir, f));
  }

  const summary = {
    ok: true, date: localDateStr(until), since, until, outdir, projects: [],
    // 当天实时即记文件（brain 技能写入）绝对路径：工作流查漏用，读不到就当不存在
    inbox: path.join(REPO_ROOT, 'raw', '公司学习', '对话即记', `${localDateStr(until)}.md`),
  };

  for (const proj of projects) {
    const suffix = proj.replace(/([_%\\])/g, '\\$1'); // LIKE 转义
    const sessions = db.prepare(
      `SELECT id, directory, title FROM session
       WHERE directory LIKE ? ESCAPE '\\' AND time_deleted IS NULL
         AND task_type IN ('interactive', 'fork')
       ORDER BY time_updated DESC`
    ).all(`%${suffix}`);

    // 同名会话只留最新一个：定时任务的每次触发、以及反复 fork 的会话都叫同一个标题
    const byTitle = new Map();
    for (const s of sessions) {
      const prev = byTitle.get(s.title);
      if (!prev || s.id > prev.id) byTitle.set(s.title, s);
    }

    const seenTurns = new Set(); // 项目级去重：fork 会复制历史消息（time_created 原样保留）
    const picked = [];
    for (const s of byTitle.values()) {
      const rows = db.prepare(
        `SELECT m.id mid, m.time_created ts, m.data mdata, p.data pdata
         FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ? AND m.time_created > ? AND m.time_created <= ?
         ORDER BY m.time_created, p.sequence`
      ).all(s.id, since, until);

      const turns = [];
      let userN = 0, aiN = 0;
      for (const r of rows) {
        let md, pd;
        try { md = JSON.parse(r.mdata); pd = JSON.parse(r.pdata); } catch { continue; }
        if (!md || pd.type !== 'text') continue;
        const text = String(pd.text || '').trim();
        if (!text) continue;
        if (md.role === 'user') {
          if (isNoise(text) || userN >= 150) continue;
          const key = `u:${r.ts}:${text.slice(0, 80)}`;
          if (seenTurns.has(key)) continue;
          seenTurns.add(key);
          turns.push({ ts: r.ts, role: 'user', text: text.slice(0, 2500) });
          userN++;
        } else if (md.role === 'assistant') {
          // 短于 40 字的多是过程性口播（"我先看一下"），不进提炼原料
          if (aiN >= 60 || text.length < 40) continue;
          const key = `a:${r.ts}:${text.slice(0, 80)}`;
          if (seenTurns.has(key)) continue;
          seenTurns.add(key);
          turns.push({ ts: r.ts, role: 'assistant', text: text.slice(0, 800) });
          aiN++;
        }
      }
      if (turns.length > 0) picked.push({ title: s.title, directory: s.directory, turns, userN, aiN, lastTs: rows.length ? rows[rows.length - 1].ts : 0 });
    }

    // 体积护栏：最多 10 个会话（按最后活跃取新），总量 180KB（提炼子代理一次读得动的量）
    picked.sort((a, b) => b.lastTs - a.lastTs);
    let kept = picked.slice(0, 10);
    let bytes = 0;
    for (const k of kept) bytes += JSON.stringify(k).length;
    while (bytes > 180 * 1024 && kept.length > 1) {
      bytes -= JSON.stringify(kept.pop()).length;
    }

    const file = path.join(outdir, `${proj}.json`);
    const dump = {
      project: proj, label: PROJECT_LABELS[proj] || proj, date: summary.date, since, until,
      sessions: kept.map((k) => ({ title: k.title, directory: k.directory, turns: k.turns })),
    };
    fs.writeFileSync(file, JSON.stringify(dump, null, 1), 'utf8');
    summary.projects.push({
      project: proj, label: PROJECT_LABELS[proj] || proj,
      sessions: kept.length,
      userTurns: kept.reduce((a, k) => a + k.userN, 0),
      assistantTurns: kept.reduce((a, k) => a + k.aiN, 0),
      bytes, file, absFile: file,
    });
    process.stderr.write(`[extract] ${proj}: ${kept.length} sessions, ${summary.projects[summary.projects.length - 1].userTurns} user turns, ${(bytes / 1024).toFixed(0)}KB\n`);
  }
  db.close();
  console.log(JSON.stringify(summary));
}

function advance() {
  const opts = parseArgs(process.argv.slice(3));
  const until = Number(opts.until);
  if (!Number.isFinite(until)) {
    console.error('advance: --until <epoch-ms> required');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const prev = readState();
  fs.writeFileSync(STATE_PATH, JSON.stringify({ lastUntil: until, lastRun: new Date().toISOString(), prevUntil: prev.lastUntil || null }, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, lastUntil: until }));
}

const cmd = process.argv[2];
if (cmd === 'extract') extract();
else if (cmd === 'advance') advance();
else {
  console.error('usage: zcode-digest.cjs extract|advance ...');
  process.exit(1);
}
