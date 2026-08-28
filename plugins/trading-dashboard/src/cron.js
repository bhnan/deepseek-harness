/** 全局定时任务服务（host 常驻，非 session 级）。
 *
 * 任务定义（data/cron/tasks.json，用户可编辑）：
 *   {
 *     "id": "daily-pipeline",
 *     "name": "盘后数据管道",
 *     "schedule": { "type": "daily_trading" | "daily" | "interval_minutes",
 *                    "time": "HH:MM" | "interval": N },
 *     "tz": "Asia/Shanghai",
 *     "command": "/abs/path", "args": [...],
 *     "enabled": true, "timeout_minutes": 60,
 *     "last_run": "...", "last_status": "success|failed|running", "last_log": "path"
 *   }
 *
 * 触发模型（v1，够用优先，不做完整 cron 表达式）：
 *   - daily_trading：每个交易日 HH:MM（读 data/calendar/trade_dates.json；缺失回退周一~周五）
 *   - daily：每天 HH:MM
 *   - interval_minutes：每 N 分钟（最小 5）
 * 补跑：dsh 停机错过触发 → 当日再启动时若该任务当天尚未成功跑过则补跑一次（标 catchup）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TICK_MS = 30_000;
const MIN_INTERVAL = 5;

/** 取时区下的日期/时间（Node 全量 ICU）。 */
function nowParts(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    seconds: Number(p.second),
    iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`,
  };
}

/** 交易日判定：优先日历文件，缺失回退周一~周五。 */
function isTradingDay(dateStr, calendarFile) {
  try {
    if (calendarFile && fs.existsSync(calendarFile)) {
      const dates = JSON.parse(fs.readFileSync(calendarFile, "utf8"));
      return dates.includes(dateStr);
    }
  } catch { /* 回退 */ }
  const d = new Date(dateStr + "T12:00:00");
  const wd = d.getDay();
  return wd >= 1 && wd <= 5;
}

/** 任务是否到期（纯函数，可单测）。 */
function isDue(task, now, calendarFile) {
  if (!task.enabled) return false;
  const { type } = task.schedule || {};
  if (type === "interval_minutes") {
    const n = Math.max(Number(task.schedule.interval) || MIN_INTERVAL, MIN_INTERVAL);
    if (!task.last_run) return true;
    const last = new Date(task.last_run).getTime();
    return now.getTime() - last >= n * 60_000;
  }
  // daily / daily_trading：当天 HH:MM 已到 && 当天尚未成功跑过
  const tz = task.tz || "Asia/Shanghai";
  const nowTz = nowParts(tz, now);          // 用传入的 now（可测），而非墙钟
  const due = task.schedule.time;          // "HH:MM"
  if (!due) return false;
  if (nowTz.time < due) return false;      // 未到点
  if (type === "daily_trading" && !isTradingDay(nowTz.date, calendarFile)) return false;
  // 当天已成功跑过 → 不重复
  if (task.last_run) {
    const lastTz = nowPartsInTz(new Date(task.last_run), tz);
    if (lastTz.date === nowTz.date && task.last_status === "success") return false;
  }
  return true;
}

function nowPartsInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

class CronService {
  constructor({ tasksFile, calendarFile, logDir, python }) {
    this.tasksFile = tasksFile;
    this.calendarFile = calendarFile;
    this.logDir = logDir;
    this.python = python;
    this.inflight = new Set();
  }

  loadTasks() {
    try {
      return JSON.parse(fs.readFileSync(this.tasksFile, "utf8")).tasks || [];
    } catch {
      return [];
    }
  }

  saveTasks(tasks) {
    fs.mkdirSync(path.dirname(this.tasksFile), { recursive: true });
    fs.writeFileSync(this.tasksFile, JSON.stringify({ tasks }, null, 2), "utf8");
  }

  list() {
    return this.loadTasks().map((t) => ({ ...t, running: this.inflight.has(t.id) }));
  }

  run(taskId) {
    const tasks = this.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return { error: "task_not_found" };
    if (this.inflight.has(task.id)) return { error: "already_running" };
    this._execute(task, tasks, { manual: true });
    return { ok: true };
  }

  toggle(taskId, enabled) {
    const tasks = this.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return { error: "task_not_found" };
    task.enabled = !!enabled;
    this.saveTasks(tasks);
    return { ok: true, enabled: task.enabled };
  }

  tick() {
    const tasks = this.loadTasks();
    const now = new Date();
    for (const task of tasks) {
      if (this.inflight.has(task.id)) continue;
      if (isDue(task, now, this.calendarFile)) {
        this._execute(task, tasks, { manual: false });
      }
    }
  }

  _execute(task, tasks, { manual }) {
    this.inflight.add(task.id);
    const tz = task.tz || "Asia/Shanghai";
    const stamp = nowParts(tz);
    const logFile = path.join(this.logDir, `${task.id}-${stamp.date}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const log = fs.createWriteStream(logFile, { flags: "a" });
    log.write(`\n===== ${stamp.iso} (${manual ? "manual" : "scheduled"}) =====\n`);
    task.last_run = new Date().toISOString();
    task.last_status = "running";
    task.last_log = logFile;
    this.saveTasks(tasks);

    const child = spawn(task.command, task.args || [], { env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const timer = setTimeout(() => {
      log.write("\n[timeout] killed\n");
      child.kill("SIGKILL");
    }, (task.timeout_minutes || 60) * 60_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      log.end();
      this.inflight.delete(task.id);
      const tasks2 = this.loadTasks();
      const t = tasks2.find((x) => x.id === task.id);
      if (t) {
        t.last_status = code === 0 ? "success" : "failed";
        t.last_exit_code = code;
        t.last_log = logFile;
        this.saveTasks(tasks2);
      }
    });
  }
}

module.exports = { CronService, isDue, isTradingDay, nowParts, MIN_INTERVAL };
