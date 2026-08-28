/** host 数据路由：/api/trading/* → data/ 只读 JSON + lab 列表 + 个股日线导出。

测试点 P2：路径越界防护、仅 JSON、404 约定、lab 白名单、symbol 格式校验。
纯函数 resolveRequest/resolveLab/resolveStock 供 node 单测。
*/
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const PREFIX = "/api/trading";
const STOCK_RE = /^(sh|sz|bj)\d{6}$/;
const SECTOR_RE = /^801\d{3}$/;
const LAB_KINDS = ["ideas", "signals", "strategies", "experiments", "runs", "evaluations", "conclusions", "configs"];

function resolveRequest(reqUrl, dataRoot) {
  const url = new URL(reqUrl, "http://localhost");
  const pathname = url.pathname;
  if (pathname === PREFIX + "/latest.json") return { kind: "latest" };
  if (pathname === PREFIX + "/aggregate.json") {
    return { kind: "aggregate", symbols: url.searchParams.get("symbols") || "", name: url.searchParams.get("name") || "" };
  }
  if (!pathname.startsWith(PREFIX + "/")) return { status: 404, error: "unknown_route" };
  let rel;
  try { rel = decodeURIComponent(pathname.slice(PREFIX.length + 1)); }
  catch { return { status: 400, error: "bad_encoding" }; }
  if (!rel.endsWith(".json")) return { status: 404, error: "only_json" };
  const base = path.resolve(dataRoot);
  const file = path.resolve(base, rel);
  if (file !== base && !file.startsWith(base + path.sep)) return { status: 403, error: "path_escape" };
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { status: 404, error: "not_found" };
  return { kind: "file", file };
}

function latestDate(dataRoot) {
  const cal = path.join(dataRoot, "calendar", "trade_dates.json");
  if (!fs.existsSync(cal)) return null;
  const dates = JSON.parse(fs.readFileSync(cal, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  // 从最近交易日往回找，返回第一个"有数据"的交易日（盘前/管道未跑时回落到昨日）
  const past = dates.filter((d) => d <= today).reverse();
  for (const d of past) {
    const marker = path.join(dataRoot, "market", d, "index_spot.json");
    if (fs.existsSync(marker)) return d;
  }
  return null;   // 完全没有数据（管道从未运行）
}

/** lab 列表（只读白名单扫描，越界不可达：只枚举受控子目录）。 */
function listLab(labRoot) {
  const out = { ideas: [], signals: {}, strategies: {}, experiments: [], conclusions: [], evaluations: [], tracking: [] };
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
  const ideasDir = path.join(labRoot, "ideas");
  if (fs.existsSync(ideasDir))
    for (const f of fs.readdirSync(ideasDir)) if (f.endsWith(".json")) {
      const d = read(path.join(ideasDir, f)); if (d) out.ideas.push(d);
    }
  for (const kind of ["signals", "strategies"]) {
    const dir = path.join(labRoot, kind);
    if (!fs.existsSync(dir)) continue;
    for (const id of fs.readdirSync(dir)) {
      const vdir = path.join(dir, id);
      // 跳过 index.json 等非目录项（ENOTDIR 防护）
      let isDir = false;
      try { isDir = fs.statSync(vdir).isDirectory(); } catch { isDir = false; }
      if (!isDir) continue;
      // 版本结构兼容：versions/vNNN/strategy.json（主）、vdir 平铺 *.json、vdir/vNNN/strategy.json
      let versions = [];
      const versionDir = path.join(vdir, "versions");
      if (fs.existsSync(versionDir)) {
        versions = fs.readdirSync(versionDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((d) => path.join("versions", d.name, "strategy.json"))
          .sort();
      }
      if (!versions.length) {
        const entries = fs.readdirSync(vdir, { withFileTypes: true });
        versions = entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name)
          .concat(entries.filter((e) => e.isDirectory() && e.name !== "versions")
            .map((d) => path.join(d.name, "strategy.json")))
          .sort();
      }
      out[kind][id] = versions.length ? read(path.join(vdir, versions[versions.length - 1])) : null;
    }
  }
  for (const kind of ["experiments", "conclusions", "evaluations"]) {
    const dir = path.join(labRoot, kind);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".json") && f !== "index.json") {
      const d = read(path.join(dir, f));
      // 跳过无 id 的元数据文件（index.json 等，避免前端渲染 undefined）
      if (d && typeof d.id === "string" && d.id) {
        // experiments 必须是生命周期实验（signal_id 必填）；跳过 qlib 探索遗留 stub 等非实验文件
        // （与 lifecycle/store.py check_integrity 的 legacy 跳过逻辑一致）
        if (kind === "experiments" && !(typeof d.signal_id === "string" && d.signal_id)) continue;
        out[kind].push(d);
      }
    }
  }
  const trackDir = path.join(labRoot, "tracking");
  if (fs.existsSync(trackDir)) {
    for (const expDir of fs.readdirSync(trackDir)) {
      const d = path.join(trackDir, expDir);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) {
        if (!f.startsWith("pending_")) continue;
        const p = read(path.join(d, f));
        if (p) out.tracking.push({ experiment_id: expDir, ...p });
      }
    }
  }
  return out;
}

/** 个股日线导出：symbol 白名单校验后调 python 导出脚本。 */
function stockDaily(symbol, repoRoot, python) {
  if (!STOCK_RE.test(symbol)) return { status: 400, error: "bad_symbol" };
  try {
    const script = path.join(repoRoot, "scripts", "export_daily_json.py");
    const out = execFileSync(python || "python3", [script, symbol, "500"],
      { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    return { kind: "stock", body: out };
  } catch (e) {
    if (e.code === "ENOENT") return { status: 500, error: "python_missing" };
    const detail = String(e.stderr || e.message || "")
      .split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300);
    return { status: 200, body: JSON.stringify({ symbol, bars: [], error: "daily_unavailable", detail }) };
  }
}

/** 行业日线导出（板块历史/粒度切换用）。 */
function sectorDaily(code, repoRoot, python) {
  if (!SECTOR_RE.test(code)) return { status: 400, error: "bad_sector_code" };
  try {
    const script = path.join(repoRoot, "scripts", "export_sector_daily.py");
    const out = execFileSync(python || "python3", [script, code, "500"],
      { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    return { kind: "sector", body: out };
  } catch (e) {
    if (e.code === "ENOENT") return { status: 500, error: "python_missing" };
    const detail = String(e.stderr || e.message || "").split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300);
    return { status: 200, body: JSON.stringify({ code, bars: [], error: "sector_daily_unavailable", detail }) };
  }
}

/** 指数日线导出（指数卡下钻）。 */
function indexDaily(code, repoRoot, python) {
  if (!/^(sh|sz|bj)\d{6}$/.test(code)) return { status: 400, error: "bad_index_code" };
  try {
    const script = path.join(repoRoot, "scripts", "export_index_daily.py");
    const out = execFileSync(python || "python3", [script, code, "800"],
      { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    return { kind: "index", body: out };
  } catch (e) {
    if (e.code === "ENOENT") return { status: 500, error: "python_missing" };
    const detail = String(e.stderr || e.message || "").split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300);
    return { status: 200, body: JSON.stringify({ code, bars: [], error: "index_daily_unavailable", detail }) };
  }
}

/** 多标的等权聚合日线（策略/组合 → 合成净值 K 线）。支持股票（sh/sz/bj）与板块（801xxx）。 */
function aggregateDaily(symbols, name, repoRoot, python) {
  const list = (symbols || "").split(",").map((s) => s.trim()).filter(Boolean)
    .filter((s) => STOCK_RE.test(s) || SECTOR_RE.test(s)).slice(0, 50);
  if (!list.length) return { status: 400, error: "bad_symbols" };
  try {
    const script = path.join(repoRoot, "scripts", "export_aggregate_daily.py");
    const out = execFileSync(python || "python3", [script, list.join(","), name || "组合"],
      { encoding: "utf8", timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
    return { kind: "aggregate", body: out };
  } catch (e) {
    if (e.code === "ENOENT") return { status: 500, error: "python_missing" };
    const detail = String(e.stderr || e.message || "").split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300);
    return { status: 200, body: JSON.stringify({ name, symbols: list, bars: [], error: "aggregate_unavailable", detail }) };
  }
}

module.exports = { resolveRequest, resolveLab: listLab, stockDaily, sectorDaily, indexDaily, aggregateDaily, latestDate, PREFIX };
