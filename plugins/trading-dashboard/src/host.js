/** host 半边：cordis 插件。
 *  能力：数据路由（data 只读/lab 列表/个股日线导出）、全局定时任务、文件日志、客户端错误上报、热插拔-lite。
 */
const fs = require("node:fs");
const path = require("node:path");

const { resolveRequest, resolveLab, stockDaily, sectorDaily, indexDaily, aggregateDaily, latestDate } = require("./route");
const { CronService } = require("./cron");
const { FileLogger } = require("./logger");
const { startHotReload } = require("./hotreload");

const DEFAULT_DATA_ROOT = "/root/bhn/trading/data";
const DEFAULT_REPO_ROOT = "/root/bhn/trading";
const DEFAULT_PYTHON = "/root/bhn/trading/.venv/bin/python";
const DEFAULT_PLUGIN_DIR = "/root/.dsh/plugins/trading-dashboard";

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req, cap = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size <= cap) chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

exports.name = "trading-dashboard";
exports.inject = ["webServer"];
exports.apply = (ctx, config) => {
  const cfg = config || {};
  const dataRoot = cfg.dataRoot || DEFAULT_DATA_ROOT;
  const repoRoot = cfg.repoRoot || DEFAULT_REPO_ROOT;
  const python = cfg.python || DEFAULT_PYTHON;
  const labRoot = cfg.labRoot || `${repoRoot}/lab`;
  const pluginDir = cfg.pluginDir || DEFAULT_PLUGIN_DIR;

  const log = new FileLogger(cfg.logDir || `${dataRoot}/logs/plugin`);
  log.info("plugin start", { dataRoot, repoRoot, python, hotReload: cfg.hotReload !== false });

  const cron = new CronService({
    tasksFile: cfg.tasksFile || `${dataRoot}/cron/tasks.json`,
    calendarFile: `${dataRoot}/calendar/trade_dates.json`,
    logDir: cfg.cronLogDir || `${dataRoot}/cron/logs`,
    python,
  });
  const cronTimer = setInterval(() => {
    try { cron.tick(); } catch (e) { log.error("cron tick", String(e)); }
  }, 30_000);

  // 热插拔-lite：client 源码变化 → rebuild → 版本号 +1（客户端轮询刷新）
  let buildVersion = Date.now();
  const disposeHot = cfg.hotReload !== false
    ? startHotReload({
        pluginDir,
        log,
        onBuilt: () => { buildVersion = Date.now(); },
      })
    : () => {};

  ctx.effect(() =>
    ctx.webServer.register({
      kind: "prefix",
      path: "/api/trading",
      handler: async (req, res) => {
        const start = Date.now();
        const url = new URL(req.url, "http://localhost");
        const p = url.pathname;
        try {
          // ---- 客户端错误上报 ----
          if (p === "/api/trading/log" && req.method === "POST") {
            const body = await readBody(req);
            try { log.clientReport(JSON.parse(body)); } catch { log.warn("client report 解析失败", body.slice(0, 200)); }
            return sendJson(res, 200, { ok: true });
          }
          // ---- 调试：读今日日志 ----
          if (p === "/api/trading/logs") {
            const n = Math.min(Number(url.searchParams.get("lines")) || 100, 2000);
            return sendJson(res, 200, { lines: log.tail(n) });
          }
          // ---- 热插拔版本号 ----
          if (p === "/api/trading/hot/version") {
            return sendJson(res, 200, { version: buildVersion });
          }
          // ---- 全局定时任务 ----
          if (p === "/api/trading/cron/tasks") {
            return sendJson(res, 200, { tasks: cron.list() });
          }
          if (p === "/api/trading/cron/run") {
            const r = cron.run(url.searchParams.get("id") || "");
            log.info("cron run", { id: url.searchParams.get("id"), result: r });
            return sendJson(res, 200, r);
          }
          if (p === "/api/trading/cron/toggle") {
            const r = cron.toggle(url.searchParams.get("id") || "", url.searchParams.get("enabled") !== "false");
            return sendJson(res, 200, r);
          }
          // ---- lab 列表 ----
          if (p === "/api/trading/lab/list.json" && labRoot) {
            return sendJson(res, 200, resolveLab(labRoot));
          }
          // ---- 指数日线导出（指数卡下钻） ----
          if (p.startsWith("/api/trading/index/") && p.includes("/daily.json")) {
            const code = p.split("/")[4] || "";
            const out = indexDaily(code, repoRoot, python);
            if (out.kind === "index") {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              return res.end(out.body);
            }
            if (out.body) {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              return res.end(out.body);
            }
            log.error("index daily", { code, status: out.status, error: out.error });
            return sendJson(res, out.status || 500, { error: out.error || "unknown" });
          }
          // ---- 行业日线导出（板块历史/粒度切换） ----
          if (p.startsWith("/api/trading/sector/") && p.includes("/daily.json")) {
            const code = p.split("/")[4] || "";
            const out = sectorDaily(code, repoRoot, python);
            if (out.kind === "sector") {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              return res.end(out.body);
            }
            if (out.body) {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              return res.end(out.body);
            }
            log.error("sector daily", { code, status: out.status, error: out.error });
            return sendJson(res, out.status || 500, { error: out.error || "unknown" });
          }
          // ---- 个股日线导出 ----
          if (p.startsWith("/api/trading/stock/")) {
            const symbol = p.split("/")[4] || "";
            const out = stockDaily(symbol, repoRoot, python);
            if (out.kind === "stock") {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              res.end(out.body);
              log.request("GET", p, 200, Date.now() - start);
              return;
            }
            let detail = out.error || "unknown";
            try { if (out.body) detail = (JSON.parse(out.body).detail || out.body).slice(0, 300); } catch {}
            log.error("stock daily", { symbol, status: out.status, error: out.error, detail });
            if (out.body) {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              return res.end(out.body);
            }
            return sendJson(res, out.status || 500, { error: out.error || "unknown" });
          }
          // ---- 市场宽度（独立小文件；旧日期回退从 a_spot 现提取） ----
          const breadthMatch = /^\/api\/trading\/market\/(\d{4}-\d{2}-\d{2})\/breadth\.json$/.exec(p);
          if (breadthMatch) {
            const d = breadthMatch[1];
            const breadthFile = path.join(dataRoot, "market", d, "breadth.json");
            if (fs.existsSync(breadthFile)) {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              fs.createReadStream(breadthFile).pipe(res);
              return;
            }
            // 旧日期（8/21 及以前）无独立文件 → 从 a_spot.json 现提取
            const aSpotFile = path.join(dataRoot, "market", d, "a_spot.json");
            if (fs.existsSync(aSpotFile)) {
              try {
                const parsed = JSON.parse(fs.readFileSync(aSpotFile, "utf8"));
                const mb = parsed?.data?.derived?.market_breadth;
                if (mb) {
                  log.request("GET", p, 200, Date.now() - start);
                  return sendJson(res, 200, { schema_version: "1.0", data: { market_breadth: mb } });
                }
              } catch (e) {
                log.warn("breadth fallback", { date: d, error: String(e) });
              }
            }
            log.warn("breadth unavailable", { date: d });
            return sendJson(res, 404, { error: "breadth_unavailable" });
          }
          // ---- 数据文件 ----
          const out = resolveRequest(req.url, dataRoot);
          if (out.kind === "latest") {
            const d = latestDate(dataRoot);
            return sendJson(res, 200, { date: d });
          }
          // ---- 策略/组合聚合日线（等权净值 K 线） ----
          if (out.kind === "aggregate") {
            const agg = aggregateDaily(out.symbols, out.name, repoRoot, python);
            if (agg.kind === "aggregate") {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              return res.end(agg.body);
            }
            log.error("aggregate", { symbols: out.symbols, status: agg.status, error: agg.error });
            return sendJson(res, agg.status || 500, { error: agg.error || "unknown" });
          }
          if (out.kind === "file") {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            fs.createReadStream(out.file).pipe(res);
            return;
          }
          if (out.status) log.warn("data route", { path: p, status: out.status, error: out.error });
          return sendJson(res, out.status || 404, { error: out.error || "unknown" });
        } catch (e) {
          log.error("handler", { path: p, stack: String(e && e.stack || e).slice(0, 500) });
          return sendJson(res, 500, { error: "internal" });
        }
      },
    })
  );

  ctx.on("dispose", () => {
    clearInterval(cronTimer);
    disposeHot();
    log.info("plugin dispose");
  });
};
