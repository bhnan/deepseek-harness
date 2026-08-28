/** 看板应用：7 页 + 数据加载 + 实体卡。入口 index.jsx 挂在 sidebar 按钮。 */
import { createElement as h, Fragment, useEffect, useRef, useState } from "react";
import { C, Card, Badge, Stat, Empty, Table, VizBlock, fmtPct, toneColor, resampleBars, GranularitySwitch } from "./ui.jsx";
import { adaptIndex, adaptIndustry, adaptStock, adaptStrategy, EntityCard } from "./adapters.jsx";
import { parseAsset, assetNameOf, mergeNewsItems } from "./validate.js";
import { report } from "./report.js";

const API = "/api/trading";

/** 6 位代码 → 带交易所前缀（60/68→sh，4/8→bj，其余→sz）；已带前缀原样返回 */
function toSymbol(code) {
  const c = String(code || "").trim();
  if (/^(sh|sz|bj)\d{6}$/.test(c)) return c;
  if (/^\d{6}$/.test(c)) {
    if (c.startsWith("6")) return "sh" + c;
    if (c.startsWith("4") || c.startsWith("8")) return "bj" + c;
    return "sz" + c;
  }
  return null;
}

/** 简单技术分析：基于日线 bars 计算短中期统计与均线结论（K 线下钻卡用） */
function simpleAnalysis(bars) {
  if (!bars || bars.length < 3) return null;
  const closes = bars.map((b) => Number(b.close)).filter((v) => Number.isFinite(v));
  if (closes.length < 3) return null;
  const last = closes[closes.length - 1];
  const pct = (n) => (closes.length > n ? (last / closes[closes.length - 1 - n] - 1) * 100 : null);
  const ma = (n) => (closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null);
  const ma5 = ma(5), ma20 = ma(20), ma60 = ma(60);
  const trend = ma5 != null && ma20 != null
    ? (ma5 > ma20 * 1.001 ? "多头排列（MA5 > MA20）" : ma5 < ma20 * 0.999 ? "空头排列（MA5 < MA20）" : "均线粘合（方向未明）")
    : "数据不足";
  const win60 = closes.length >= 60 ? closes.slice(-60) : closes;
  return { latest: last, chg5: pct(5), chg20: pct(20), chg60: pct(60), ma5, ma20, ma60, trend, hi60: Math.max(...win60), lo60: Math.min(...win60) };
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    report("error", `http ${res.status}`, url);
    throw new Error(`${res.status}`);
  }
  return res.json();
}

function useLatest() {
  const [state, setState] = useState({ date: null, error: null });
  useEffect(() => {
    getJSON(`${API}/latest.json`).then((r) => setState({ date: r.date, error: null }))
      .catch((e) => setState({ date: null, error: String(e) }));
  }, []);
  return state;
}

function useAsset(path, key) {
  const { date } = useLatest();
  const [state, setState] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    if (!date) return;
    getJSON(`${API}/${path.replace("{date}", date)}`)
      .then((r) => {
        try {
          // zod 核心字段守卫：解析失败 → 降级为"数据异常"，不带病渲染（测试点 X1）
          setState({ data: parseAsset(assetNameOf(path), r), error: null, loading: false });
        } catch (e) {
          setState({ data: null, error: `数据异常(schema): ${e.issues?.[0]?.path || e.message}`, loading: false });
        }
      })
      .catch((e) => setState({ data: null, error: String(e), loading: false }));
  }, [date, path]);
  return state;
}

/* ============ 页面 ============ */

/** 新闻详情弹层（点开新闻标题 → 公告正文/快讯全文/原文链接） */
function NewsModal({ item, onClose }) {
  return h("div", { onClick: onClose,
      style: { position: "fixed", inset: 0, zIndex: 9500, background: "rgba(31,39,51,0.45)", display: "flex", alignItems: "center", justifyContent: "center" } },
    h("div", { onClick: (e) => e.stopPropagation(),
      style: { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, maxWidth: 560, width: "90%", maxHeight: "70vh", overflow: "auto" } },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10 } },
        h("span", { style: { fontSize: 15, fontWeight: 700, color: C.text, flex: 1 } }, item.title),
        h("button", { onClick: onClose, style: { background: C.fill, border: `1px solid ${C.border}`, borderRadius: 6, padding: "2px 10px", cursor: "pointer", color: C.text } }, "✕")),
      h("div", { style: { fontSize: 12, color: C.sub, marginBottom: 10 } },
        `${item.date || ""}${item.source ? " · " + item.source : ""}${item.kind === "announcement" ? " · 公告" : ""}`),
      h("div", { style: { fontSize: 13, color: C.text, lineHeight: 1.7, whiteSpace: "pre-wrap" } },
        item.content || "（无正文）"),
      item.url ? h("div", { style: { marginTop: 12 } },
        h("a", { href: item.url, target: "_blank", rel: "noreferrer", style: { color: C.accent, fontSize: 13 } }, "查看原文 ↗")) : null));
}

/** 在当日事件数据中按标题匹配详情（公告→cninfo 链接；快讯→全文） */
function findNewsDetail(eventsData, title) {
  const data = eventsData?.data || eventsData || {};
  const ann = (data.announcements || []).find((a) => a["公告标题"] === title);
  if (ann) {
    return { kind: "announcement", title, date: ann["公告时间"] || "", source: "cninfo",
             content: ann.derived?.note || `公告：${title}`,
             url: ann["公告链接"] || "" };
  }
  const f = (data.flashes || []).find((x) => x["标题"] === title);
  if (f) {
    return { kind: "flash", title, date: `${f["发布日期"] || ""} ${f["发布时间"] || ""}`.trim(),
             source: "快讯", content: f["内容"] || "", url: f["链接"] || "" };
  }
  return null;
}

/** 程序跳转后的返回入口（面包屑式，导航栈驱动） */
function BackBar({ back }) {
  return back ? h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 } },
    h("button", { onClick: back.onBack, style: { background: C.fill, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12 } },
      `← 返回 ${back.label}`)) : null;
}

function Overview({ onOpenSector }) {
  const idx = useAsset("market/{date}/index_spot.json");
  const breadthData = useAsset("market/{date}/breadth.json");
  const sw = useAsset("sector/{date}/sw_l1_spot.json");
  const review = useAsset("review/{date}/review.json");
  const events = useAsset("events/{date}/announcements.json");
  const [newsItem, setNewsItem] = useState(null);
  const inds = (idx.data?.data?.indices || []).map(adaptIndex);
  const breadth = breadthData.data?.data?.market_breadth;
  const industries = (sw.data?.data?.industries || []).map(adaptIndustry)
    .sort((a, b) => (b.change_percent ?? -99) - (a.change_percent ?? -99));
  const rv = review.data?.data;

  return h(Fragment, null,
    newsItem ? h(NewsModal, { item: newsItem, onClose: () => setNewsItem(null) }) : null,
    h("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" } },
      inds.map((e) => h(EntityCard, { key: e.ticker + e.market, e }))),
    h("div", { style: { display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" } },
      h(Card, { title: "市场宽度", style: { flex: "1 1 260px" } },
        breadth ? h("div", { style: { display: "flex", gap: 16, flexWrap: "wrap" } },
          h(Stat, { label: "上涨家数", value: breadth.advancers, color: C.up }),
          h(Stat, { label: "下跌家数", value: breadth.decliners, color: C.down }),
          h(Stat, { label: "涨停/跌停", value: `${breadth.limit_up} / ${breadth.limit_down}` }),
          h(Stat, { label: "两市成交额", value: (breadth.total_amount / 1e12).toFixed(2) + " 万亿" }))
          : h(Empty, { text: "宽度数据缺失（整块隐藏，不显示 0）" })),
      h(Card, { title: "Agent 盘后复盘", style: { flex: "1 1 340px" } },
        rv ? h(Fragment, null,
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8, alignItems: "center" } },
            String(rv.summary).includes("待 Agent 生成") ? h(Badge, { text: "待回填（数字已注入）", kind: "warn" }) : null,
            h(Badge, { text: `regime: ${rv.regime}`, kind: "info" }),
            h(Badge, { text: `trend: ${rv.trend}`, kind: "info" }),
            h(Badge, { text: `risk: ${rv.risk_level}`, kind: rv.risk_level === "high" ? "bad" : "warn" })),
          h("p", { style: { fontSize: 12, color: C.text, margin: "0 0 6px" } }, rv.summary),
          rv.market?.volume_note ? h("p", { style: { fontSize: 12, color: C.sub, margin: 0 } }, rv.market.volume_note) : null,
          rv.market?.breadth_note ? h("p", { style: { fontSize: 12, color: C.sub, margin: "4px 0 0" } }, rv.market.breadth_note) : null,
          rv.news?.length ? h("div", { style: { marginTop: 8, fontSize: 11, color: C.sub } },
            "今日要点: ",
            rv.news.map((n, i) => h(Fragment, { key: i },
              i > 0 ? "；" : null,
              h("a", { href: "#", onClick: (ev) => { ev.preventDefault();
                  setNewsItem(findNewsDetail(events.data, n.title) || { title: n.title, content: "（详情未收录）" }); },
                  style: { color: C.accent, textDecoration: "none", cursor: "pointer", marginLeft: i > 0 ? 4 : 0 } },
                n.title)))) : null)
          : h(Empty, { text: review.error ? `复盘未生成 (${review.error})` : "加载中…" }))),
    h(Card, { title: "申万一级行业涨跌榜 · 点击行业查看板块", style: { marginTop: 12 } },
      industries.length ? h("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" } },
        h("div", { style: { flex: "1 1 320px" } }, h(HbarRankFromIndustries, { industries: industries.slice(0, 6), onOpenSector })),
        h("div", { style: { flex: "1 1 320px" } }, h(HbarRankFromIndustries, { industries: industries.slice(-6).reverse(), losers: true, onOpenSector })))
        : h(Empty, { text: sw.error ? `行业数据缺失 (${sw.error})` : "加载中…" })));
}

function HbarRankFromIndustries({ industries, losers, onOpenSector }) {
  const items = industries.map((i) => ({ label: i.name, value: i.change_percent, ticker: i.ticker }));
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  return h("div", null,
    h("div", { style: { fontSize: 11, color: C.sub, marginBottom: 4 } }, losers ? "领跌" : "领涨"),
    items.map((it, i) => h("div", { key: i, onClick: onOpenSector ? () => onOpenSector(it.ticker) : undefined,
      style: { display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: onOpenSector ? "pointer" : "default" } },
      h("span", { style: { width: 84, fontSize: 12, flex: "0 0 auto" } }, it.label),
      h("div", { style: { flex: 1, height: 8, background: C.fill, borderRadius: 4, overflow: "hidden" } },
        h("div", { style: { width: `${(Math.abs(it.value) / max) * 100}%`, height: "100%", background: losers ? C.down : C.up, borderRadius: 4 } })),
      h("span", { style: { width: 56, textAlign: "right", fontSize: 12 } }, fmtPct(it.value)))));
}

function SectorDetail({ ind, onOpenStock }) {
  const membersSpot = useAsset("sector/{date}/members_spot.json");
  const [gran, setGran] = useState("day");
  const [daily, setDaily] = useState({ loading: true, data: null, error: null });
  const [comps, setComps] = useState(null);
  useEffect(() => {
    setDaily({ loading: true, data: null, error: null });
    getJSON(`${API}/sector/${ind.ticker}/daily.json`)
      .then((r) => setDaily({ loading: false, data: r, error: r.error || null }))
      .catch((e) => setDaily({ loading: false, data: null, error: String(e) }));
    getJSON(`${API}/sector/components/${ind.ticker}.json`)
      .then((r) => setComps(r))
      .catch(() => setComps(null));
  }, [ind.ticker]);
  // 成分股行情来自管道预计算的 members_spot.json（KB 级），不再下载 1.9MB a_spot 现算
  // 文件结构 {schema_version, data: {by_sector}} → 需两层 .data 解包
  const spotMap = new Map((membersSpot.data?.data?.by_sector?.[ind.ticker] || []).map((s) => [String(s["代码"]), s]));
  const members = (comps || []).map((m) => {
    const quote = spotMap.get(String(m["证券代码"] || ""));
    return { name: m["证券名称"] || "", code: String(m["证券代码"] || ""),
             weight: Number(m["最新权重"] || 0),
             change_pct: quote ? Number(quote["涨跌幅"]) : null };
  }).sort((a, b) => (b.change_pct ?? -99) - (a.change_pct ?? -99));
  const up = members.slice(0, 5), down = members.slice(-5).reverse();
  // 板块内涨跌家数统计（有行情数据才算，无行情单独计数）
  const upCount = members.filter((m) => m.change_pct != null && m.change_pct > 0).length;
  const downCount = members.filter((m) => m.change_pct != null && m.change_pct < 0).length;
  const flatCount = members.filter((m) => m.change_pct != null && m.change_pct === 0).length;
  const naCount = members.length - upCount - downCount - flatCount;
  // 右栏详情：K 线与成分股垂直排列
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
    h(Card, { title: `${ind.name}（${ind.ticker}）· 历史走势` },
      h("div", { style: { marginBottom: 8 } }, h(GranularitySwitch, { value: gran, onChange: setGran })),
      daily.loading ? h(Empty, { text: "加载中…" })
        : daily.error ? h(Empty, { text: "行业日线不可用: " + daily.error })
        : daily.data?.bars?.length ? h(VizBlock, { block: { kind: "price_kline", payload: { ticker: ind.ticker, market: "sw", bars: resampleBars(daily.data.bars, gran).slice(-160) } } })
        : h(Empty, { text: "无日线数据" })),
    h(Card, { title: "成分股领涨 / 领跌（当日）· 点击查看个股" },
      members.length ? h(Fragment, null,
        h("div", { style: { display: "flex", gap: 14, fontSize: 12, marginBottom: 8, padding: "6px 10px", background: C.fill, borderRadius: 6 } },
          h("span", { style: { color: C.up, fontWeight: 700 } }, `涨 ${upCount}`),
          h("span", { style: { color: C.down, fontWeight: 700 } }, `跌 ${downCount}`),
          h("span", { style: { color: C.sub } }, `平 ${flatCount}`),
          naCount ? h("span", { style: { color: C.sub } }, `无行情 ${naCount}`) : null,
          h("span", { style: { color: C.sub } }, `共 ${members.length} 只`)),
        h("div", { style: { fontSize: 12, color: C.sub, marginBottom: 6 } }, "领涨"),
        up.map((m) => h("div", { key: m.code, onClick: () => onOpenStock && onOpenStock(m.code, m.name),
          style: { display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0", cursor: onOpenStock ? "pointer" : "default" } },
          h("span", null, m.name || m.code),
          h("span", { style: { color: toneColor(m.change_pct) } }, fmtPct(m.change_pct)))),
        h("div", { style: { fontSize: 12, color: C.sub, margin: "10px 0 6px" } }, "领跌"),
        down.map((m) => h("div", { key: m.code, onClick: () => onOpenStock && onOpenStock(m.code, m.name),
          style: { display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0", cursor: onOpenStock ? "pointer" : "default" } },
          h("span", null, m.name || m.code),
          h("span", { style: { color: toneColor(m.change_pct) } }, fmtPct(m.change_pct)))))
        : h(Empty, { text: "成分股未采集或行情未落盘" })));
}

/** 手动滚动到元素居中（scrollIntoView 在 DSH fixed overlay 环境实测失效，改为计算滚动容器偏移） */
function scrollIntoViewSafe(el) {
  if (!el) return;
  let sc = el.parentElement;
  while (sc && sc !== document.body) {
    const cs = getComputedStyle(sc);
    if (sc.scrollHeight > sc.clientHeight && (cs.overflowY === "auto" || cs.overflowY === "scroll")) break;
    sc = sc.parentElement;
  }
  if (!sc || sc === document.body) return;
  const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  sc.scrollTop = Math.max(0, top - sc.clientHeight / 2 + el.clientHeight / 2);
}

/** 详情区渲染后自动滚动进视口（点击行 → 详情在下方 → 用户看不到 = "点不进去"）。
 *  不用 rAF/scrollIntoView：DSH 环境两者均实测失效，用 setTimeout + 手动计算。 */
function useScrollToDetail(active) {
  const ref = useRef(null);
  useEffect(() => {
    if (active) {
      const id = setTimeout(() => scrollIntoViewSafe(ref.current), 0);
      return () => clearTimeout(id);
    }
  }, [active]);
  return ref;
}

function Sector({ onOpenStock, sectorTarget, back }) {
  const sw = useAsset("sector/{date}/sw_l1_spot.json");
  const review = useAsset("review/{date}/review.json");
  const industries = (sw.data?.data?.industries || []).map(adaptIndustry);
  const rv = review.data?.data;
  // 单选：点击左侧行业 → 右侧详情切换为该行业；未点击时默认选中列表最上面的行业（涨幅第一）
  const [sel, setSel] = useState(null);
  const [lastTarget, setLastTarget] = useState(null);
  const sorted = [...industries].sort((a, b) => (b.change_percent ?? -99) - (a.change_percent ?? -99));
  // 外部跳转（概览页行业榜点击 → 选中对应行业）
  useEffect(() => {
    if (sectorTarget && sectorTarget.ts !== lastTarget && industries.length) {
      const found = industries.find((i) => i.ticker === sectorTarget.ticker);
      if (found) { setSel(found); setLastTarget(sectorTarget.ts); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectorTarget, industries]);
  // 默认第一个：仅当没有外部跳转目标时（避免与跳转 effect 竞态覆盖）
  useEffect(() => {
    if (sel === null && sorted.length && !sectorTarget) setSel(sorted[0]);
  }, [sorted, sel, sectorTarget]);
  // 选中行业后（点击/跳转/默认），自动滚动到可见（居中）。
  // 在 effect 里执行：React 渲染完成后 DOM 最新，行必然存在；scrollIntoViewSafe 自动滚内部列表容器
  useEffect(() => {
    if (!sel) return;
    setTimeout(() => scrollIntoViewSafe(document.querySelector(`[data-table-row="${sel.ticker}"]`)), 0);
  }, [sel]);
  // 左列高度 = 右列（复盘+K线+成分股）实际高度，下沿对齐成分股；动态测量（内容异步加载后补测）
  const rightRef = useRef(null);
  const [listH, setListH] = useState(null);
  useEffect(() => {
    let alive = true;
    const measure = () => {
      if (alive && rightRef.current) setListH(Math.round(rightRef.current.getBoundingClientRect().height));
    };
    measure();
    const timers = [300, 900, 1800].map((ms) => setTimeout(measure, ms));   // K线/成分股异步加载后补测
    window.addEventListener("resize", measure);
    return () => { alive = false; timers.forEach(clearTimeout); window.removeEventListener("resize", measure); };
  }, [sel, rv?.sector != null]);
  const clickRow = (r) => setSel(r);
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
    h(BackBar, { back }),
    h("div", { style: { display: "flex", gap: 12, alignItems: "flex-start" } },
    // 左列：全部板块列表（独立滚动区块：高度与右列下沿对齐，内部滚动）
    h(Card, { title: `申万一级行业（${industries.length}）· 点击查看 K 线（高亮 = 右侧当前展示）`,
        style: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column",
                 height: listH || "calc(100vh - 150px)", maxHeight: "calc(100vh - 40px)", overflow: "hidden" } },
      h("div", { style: { flex: 1, overflow: "auto", minHeight: 0 } },
        h(Table, {
          columns: [
            { key: "name", label: "行业" },
            { key: "change_percent", label: "涨跌幅", render: (r) => h("span", { style: { color: toneColor(r.change_percent) } }, fmtPct(r.change_percent)) },
            { key: "pe", label: "PE(TTM)", render: (r) => (r.pe != null ? r.pe.toFixed(1) : "--") },
            { key: "member_count", label: "成分" },
            { key: "amount", label: "成交额(亿)", render: (r) => (r.amount != null ? (r.amount / 100).toFixed(0) : "--") },
          ],
          rows: sorted, rowKey: "ticker",
          selectedKey: sel ? sel.ticker : null,
          onRowClick: clickRow,
        }))),
    // 右列（窄）：复盘 → K 线 → 成分股
    h("div", { ref: rightRef, style: { width: 480, flex: "0 0 480px", display: "flex", flexDirection: "column", gap: 12 } },
      h(Card, { title: "板块复盘" },
        rv?.sector ? h("div", { style: { fontSize: 12, display: "flex", flexDirection: "column", gap: 4 } },
          h("div", { style: { color: C.sub } },
            [["持续性", rv.sector.continuation], ["扩散度", rv.sector.diffusion],
             ["分歧", rv.sector.divergence], ["风格", rv.sector.market_style]]
              .map(([k, v]) => h("span", { key: k, style: { marginRight: 8 } }, `${k}: ${v || "--"}`))),
          h("div", null, "强势: " + (rv.sector.leading_sectors || []).map((s) => s.name).join("、")),
          h("div", null, "弱势: " + (rv.sector.lagging_sectors || []).map((s) => s.name).join("、")),
          (rv.sector.retreat_signals || []).length ? h("div", { style: { color: C.warn } }, "退潮: " + rv.sector.retreat_signals.join("、")) : null)
          : h(Empty, { text: "复盘未生成" })),
      sel ? h(SectorDetail, { ind: sel, onOpenStock: (code, name) => onOpenStock && onOpenStock(code, name, sel.ticker) })
        : h(Empty, { text: "点击左侧行业，此处显示 K 线与成分股" }))));
}

function Entity({ target, back }) {
  const spot = useAsset("market/{date}/a_spot.json");
  const events = useAsset("events/{date}/announcements.json");
  const [q, setQ] = useState("");
  const [sym, setSym] = useState(null);
  const detailRef = useScrollToDetail(!!sym);
  const [kline, setKline] = useState({ loading: false, data: null, error: null });
  const [gran, setGran] = useState("day");
  // 外部跳转（板块成分/策略候选等处点击股票 → 打开个股）
  const [applied, setApplied] = useState(null);
  useEffect(() => {
    if (target && target.ts !== applied) {
      setApplied(target.ts);
      open(target.ticker, target.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const stocks = spot.data?.data?.stocks || [];
  const found = q ? stocks.filter((s) => String(s["代码"]).includes(q.toLowerCase()) || String(s["名称"]).includes(q)) : [];
  const allNews = events.data ? mergeNewsItems(events.data) : [];
  const news = allNews.filter((a) => !sym || (a.symbol && a.symbol.endsWith(sym.ticker))
    || (!a.symbol && sym.name && (String(a.title || "").includes(sym.name))));

  const open = (code, name = "") => {
    const symCode = toSymbol(code) || code;
    setSym(adaptStock({ 代码: symCode, 名称: name, 最新价: null, 涨跌幅: null }));
    setKline({ loading: true, data: null, error: null });
    getJSON(`${API}/stock/${symCode}/daily.json`)
      .then((r) => setKline({ loading: false, data: r, error: r.error || null, detail: r.detail || null }))
      .catch((e) => setKline({ loading: false, data: null, error: String(e), detail: null }));
  };

  const an = kline.data?.bars ? simpleAnalysis(kline.data.bars) : null;

  return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
    h(BackBar, { back }),
    h(Card, { title: "个股查询（代码 6 位或名称）" },
      h("input", {
        value: q, placeholder: "如 600519 或 贵州",
        onChange: (e) => setQ(e.target.value),
        style: { background: C.fill, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: "8px 12px", width: 280 },
      }),
      found.length ? h("div", { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 2 } },
        found.slice(0, 10).map((s) => h("button", {
          key: s["代码"], onClick: () => open(s["代码"], s["名称"]),
          style: { background: "transparent", border: 0, color: C.text, textAlign: "left", padding: "4px 8px", cursor: "pointer", fontSize: 12 },
        }, `${s["代码"]}  ${s["名称"]}`))) : q ? h(Empty, { text: "未匹配" }) : null),
    sym ? h("div", { ref: detailRef, style: { display: "flex", gap: 12, flexWrap: "wrap" } },
      h(Card, { title: `${sym.name || sym.ticker} · K 线`, style: { flex: "1 1 460px" } },
        h("div", { style: { marginBottom: 8 } }, h(GranularitySwitch, { value: gran, onChange: setGran })),
        kline.loading ? h(Empty, { text: "K线加载中…" })
        : kline.error ? h(Empty, { text: "日线不可用: " + kline.error + (kline.detail ? "（" + kline.detail + "）" : "") })
        : kline.data?.bars?.length ? h(VizBlock, { block: { kind: "price_kline", title: sym.ticker, payload: { ticker: sym.ticker, market: "sh", bars: resampleBars(kline.data.bars, gran).slice(-160) } } })
        : h(Empty, { text: "无日线数据" })),
      h(Card, { title: "简单分析", style: { flex: "1 1 300px" } },
        kline.loading ? h(Empty, { text: "K线加载中…" })
        : !an ? h(Empty, { text: "数据不足（需至少 3 根日线）" })
        : h("div", { style: { fontSize: 12, display: "flex", flexDirection: "column", gap: 7 } },
          h("div", { style: { display: "flex", justifyContent: "space-between" } },
            h("span", { style: { color: C.sub } }, "最新收盘"), h("span", { style: { fontWeight: 700, fontSize: 15 } }, an.latest.toFixed(2))),
          h("div", { style: { display: "flex", justifyContent: "space-between" } },
            h("span", { style: { color: C.sub } }, "近 5 / 20 / 60 日"),
            h("span", null, [["5日", an.chg5], ["20日", an.chg20], ["60日", an.chg60]].map(([k, v]) =>
              h("span", { key: k, style: { marginLeft: 8, color: v == null ? C.sub : toneColor(v) } }, `${k} ${v == null ? "--" : fmtPct(v)}`)))),
          h("div", { style: { display: "flex", justifyContent: "space-between" } },
            h("span", { style: { color: C.sub } }, "MA5 / MA20 / MA60"),
            h("span", null, [an.ma5, an.ma20, an.ma60].map((v) => v == null ? "--" : v.toFixed(2)).join(" / "))),
          h("div", { style: { display: "flex", justifyContent: "space-between" } },
            h("span", { style: { color: C.sub } }, "均线形态"),
            h("span", { style: { fontWeight: 600, color: an.trend.includes("多头") ? C.up : an.trend.includes("空头") ? C.down : C.sub } }, an.trend)),
          h("div", { style: { display: "flex", justifyContent: "space-between" } },
            h("span", { style: { color: C.sub } }, "近 60 日区间"),
            h("span", null, `${an.lo60.toFixed(2)} ~ ${an.hi60.toFixed(2)}`)))),
      h(Card, { title: "相关公告/新闻", style: { flex: "1 1 100%" } },
        news.length ? h(VizBlock, { block: { kind: "timeline", payload: { items: news } } })
          : h(Empty, { text: "近 7 日无相关公告（自选范围）· 全局快讯中无提及" }))) : null);
}

/** 策略/组合聚合面板：等权净值 K 线（日/周/月）+ 股票列表（点击跳个股）。呈现与板块详情一致。 */
function AggregatePanel({ name, symbols, onOpenStock, spotMap }) {
  const [gran, setGran] = useState("day");
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const key = (symbols || []).join(",");
  useEffect(() => {
    setState({ loading: true, data: null, error: null });
    getJSON(`${API}/aggregate.json?symbols=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`)
      .then((r) => setState({ loading: false, data: r, error: r.error || null }))
      .catch((e) => setState({ loading: false, data: null, error: String(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, name]);
  const bars = state.data?.bars || [];
  const map = spotMap || new Map();
  return h("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" } },
    h(Card, { title: `${name} · 聚合 K 线（等权净值）`, style: { flex: "1 1 460px" } },
      h("div", { style: { marginBottom: 8 } }, h(GranularitySwitch, { value: gran, onChange: setGran })),
      state.loading ? h(Empty, { text: "K线加载中…" })
      : state.error ? h(Empty, { text: "聚合不可用: " + state.error })
      : bars.length > 2 ? h(VizBlock, { block: { kind: "price_kline", title: name, payload: { ticker: name, market: "agg", bars: resampleBars(bars, gran).slice(-160) } } })
      : h(Empty, { text: "无可用日线（成分股均无历史数据）" })),
    h(Card, { title: `股票列表（${symbols.length}）· 点击查看个股`, style: { flex: "1 1 300px" } },
      symbols.length ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        symbols.map((sym) => {
          const q = map.get(sym) || map.get(toSymbol(sym));
          const nm = q?.["名称"] || sym;
          const chg = q ? Number(q["涨跌幅"]) : null;
          return h("div", { key: sym, onClick: () => onOpenStock && onOpenStock(sym, nm),
            style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", borderRadius: 6, cursor: "pointer", background: C.fill, marginBottom: 4 } },
            h("span", { style: { fontSize: 13, fontWeight: 600 } }, nm),
            h("span", { style: { fontSize: 13, color: chg == null ? C.sub : toneColor(chg) } }, chg == null ? "--" : fmtPct(chg)));
        }))
        : h(Empty, { text: "无成分股" })));
}

function Watchlist({ onOpenStock }) {
  const quotes = useAsset("market/{date}/quotes_subset.json");
  const [wl, setWl] = useState(null);
  useEffect(() => {
    getJSON(`${API}/watchlist.json`).then((r) => setWl(r)).catch(() => setWl(null));
  }, []);
  // 行情来自管道预计算的 quotes_subset.json（仅自选+信号成分，KB 级）
  // 文件结构 {schema_version, data: {quotes}} → 需两层 .data 解包
  const spotMap = new Map(Object.entries(quotes.data?.data?.quotes || {}));
  // 兼容旧结构 symbols（无 groups 时归入"自选"组合）
  const groups = wl?.groups?.length
    ? wl.groups
    : (wl?.symbols?.length ? [{ name: "自选", symbols: wl.symbols }] : []);
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 16 } },
    !groups.length ? h(Card, { title: "自选组合" }, h(Empty, { text: wl ? "暂无组合（在 data/watchlist.json 中维护）" : "加载中…" }))
    : groups.map((g) => h("div", { key: g.name },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
          h("span", { style: { fontSize: 14, fontWeight: 700 } }, g.name),
          h(Badge, { text: `${(g.symbols || []).length} 只`, kind: "info" }),
          g.note ? h("span", { style: { fontSize: 11, color: C.sub } }, g.note) : null),
        h(AggregatePanel, { name: g.name, symbols: g.symbols || [], onOpenStock, spotMap }))));
}

function Folio({ onOpenStock }) {
  const pf = useAsset("portfolio/{date}/portfolio.json");
  const data = pf.data?.data;
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
    // 自选组合（watchlist.json 手动维护）是组合页中的一组
    h(Watchlist, { onOpenStock }),
    h(Card, { title: "模拟盘组合" },
      data?.derived?.nav_history?.length ? h(Fragment, null,
        h(VizBlock, { block: { kind: "line", title: "净值", payload: { series: [{ id: "nav", label: "组合净值", points: data.derived.nav_history.map((r) => ({ date: r.date, value: r.nav })) }, { id: "bench", label: "基准", points: data.derived.nav_history.map((r) => ({ date: r.date, value: r.benchmark_nav })) }] } } }),
        h(Table, {
          columns: [
            { key: "name", label: "名称" }, { key: "symbol", label: "代码" },
            { key: "weight", label: "占比", render: (r) => (r.derived?.weight != null ? (r.derived.weight * 100).toFixed(1) + "%" : "--") },
            { key: "pnl_pct", label: "盈亏", render: (r) => h("span", { style: { color: toneColor(r.derived?.pnl_pct) } }, fmtPct(r.derived?.pnl_pct)) },
            { key: "status", label: "状态", render: (r) => h(Badge, { text: r.derived?.status || "--", kind: r.derived?.status === "near_stop" ? "warn" : "ok" }) },
          ],
          rows: data.positions || [], rowKey: "symbol",
        }))
        : h(Empty, { text: pf.error ? "模拟盘未运行（paper_trading 模块待复活，资产显示空态引导）" : "加载中…" })));
}

function Signals({ onOpenStock, onOpenSector }) {
  const sg = useAsset("signals/{date}/signals.json");
  const quotes = useAsset("market/{date}/quotes_subset.json");
  const data = sg.data?.data;
  const strategies = (data?.strategies || []).map(adaptStrategy);
  const [sel, setSel] = useState(null);
  const detailRef = useScrollToDetail(!!sel);
  const [lab, setLab] = useState(null);
  useEffect(() => {
    getJSON(`${API}/lab/list.json`).then((r) => setLab(r)).catch(() => setLab(null));
  }, []);
  // 行情来自管道预计算的 quotes_subset.json（仅自选+信号成分，KB 级）
  // 文件结构 {schema_version, data: {quotes}} → 需两层 .data 解包
  const spotMap = new Map(Object.entries(quotes.data?.data?.quotes || {}));
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
    h(Card, { title: "策略信号 · 点击策略查看详情" },
      h("div", { style: { marginBottom: 8 } },
        h(Badge, { text: data ? { scanned: "已扫描", not_scanned: "当日未扫描", disabled: "无启用策略" }[data.status] : "加载中", kind: data?.status === "scanned" ? "ok" : "warn" }),
        data ? h("span", { style: { fontSize: 11, color: C.sub, marginLeft: 8 } }, `参与扫描 ${data.scanned_count} 个策略`) : null),
      strategies.length ? h("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" } },
        strategies.map((s) => h(EntityCard, { key: s.ticker, e: s, onClick: () => setSel(s) })))
        : h(Empty, { text: sg.error ? `信号数据缺失 (${sg.error})` : "无启用策略" })),
    sel ? h("div", { ref: detailRef }, h(Card, { title: `${sel.name} · 详情`, style: { display: "flex", flexDirection: "column", gap: 12 } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
        sel.dsl_status === "executed" ? h(Badge, { text: "DSL 已执行", kind: "ok" })
          : sel.dsl_status === "error" ? h(Badge, { text: "DSL 执行失败", kind: "bad" })
          : h(Badge, { text: "Legacy（无 DSL 表达式）", kind: "warn" }),
        sel.signal_note ? h("span", { style: { fontSize: 13, color: C.warn } }, sel.signal_note) : null),
      // DSL 规则（人类可读，来自 signals.json 的 dsl_rules——collect_signals 翻译）
      (sel.dsl_rules && (sel.dsl_rules.fatigue || sel.dsl_rules.repair))
        ? h("div", { style: { fontSize: 12, background: C.fill, borderRadius: 8, padding: "8px 12px", display: "flex", flexDirection: "column", gap: 3 } },
            sel.dsl_rules.fatigue ? h("div", null,
              h("span", { style: { color: C.down, fontWeight: 600, marginRight: 6 } }, "旧强端（疲劳）"),
              h("span", { style: { color: C.text } }, sel.dsl_rules.fatigue)) : null,
            sel.dsl_rules.repair ? h("div", null,
              h("span", { style: { color: C.up, fontWeight: 600, marginRight: 6 } }, "新弱端（修复）"),
              h("span", { style: { color: C.text } }, sel.dsl_rules.repair)) : null,
            sel.dsl_rules.pairing ? h("div", { style: { color: C.sub } }, sel.dsl_rules.pairing) : null)
        : null,
      // 配对候选板块（DSL 扫描输出，members = 配对新端板块；点击跳板块页）
      (sel.members || []).length ? h("div", { style: { fontSize: 13 } },
        "配对候选: ",
        sel.members.map((c) =>
          h("span", { key: c.ticker, style: { marginRight: 10 } },
            h("a", { href: "#", onClick: (ev) => { ev.preventDefault(); onOpenSector && onOpenSector(c.ticker); },
              style: { color: C.accent, textDecoration: "none", cursor: "pointer" } },
              `${c.name || c.ticker}`),
            c.weight != null ? h("span", { style: { color: C.sub, fontSize: 12 } }, `分 ${c.weight}`) : null)))
        : null,
      // 配对板块聚合 K 线（板块代码走 aggregate 端点）
      (sel.members || []).length
        ? h(AggregatePanel, { name: `${sel.name} · 配对候选`, symbols: sel.members.map((m) => m.ticker), onOpenStock })
        : null,
      h("div", { style: { fontSize: 13 } },
        "前向跟踪候选: ",
        (lab?.tracking || []).length
          ? (lab.tracking[0].candidates || []).map((c) => {
              const q = spotMap.get(toSymbol(c.symbol)) || spotMap.get(String(c.symbol));
              return h("span", { key: c.symbol, style: { marginRight: 8 } },
                h("a", { href: "#", onClick: (ev) => { ev.preventDefault(); onOpenStock && onOpenStock(c.symbol, c.name); },
                  style: { color: C.accent, textDecoration: "none", cursor: "pointer" } },
                  `${c.name || c.symbol}${q ? `（${fmtPct(Number(q["涨跌幅"]))}）` : ""}`));
            })
          : "暂无（种子未落盘或数据未加载）")),
      h("div", { style: { fontSize: 13, color: C.sub } },
        `实验 ${(lab?.experiments || []).length} 个 · 结论 ${(lab?.conclusions || []).length} 个（详见"实验室"页）`),
      // 策略关联股票（前向跟踪候选）→ 聚合 K 线 + 股票列表（与板块呈现一致）
      (lab?.tracking || []).length && (lab.tracking[0].candidates || []).length
        ? h(AggregatePanel, { name: `${sel.name} · 候选`, symbols: lab.tracking[0].candidates.map((c) => c.symbol), onOpenStock, spotMap })
        : null)
      : null);
}

function News() {
  const ev = useAsset("events/{date}/announcements.json");
  const data = ev.data?.data;
  const items = data ? mergeNewsItems(data) : [];
  const [newsItem, setNewsItem] = useState(null);
  return h(Fragment, null,
    newsItem ? h(NewsModal, { item: newsItem, onClose: () => setNewsItem(null) }) : null,
    h(Card, { title: "新闻 / 风险（点击查看详情）" },
      ev.error ? h(Empty, { text: "新闻数据不可用: " + ev.error }) : null,
      !ev.error && data?.derived?.coverage_note ? h("div", { style: { fontSize: 11, color: C.sub, marginBottom: 8 } }, data.derived.coverage_note) : null,
      !ev.error && items.length ? h(VizBlock, { block: { kind: "timeline", payload: { items } },
          onItemClick: (it) => setNewsItem(findNewsDetail(data, it.title) || { title: it.title, summary: it.summary, content: "（详情未收录）", date: it.date, source: it.source }) })
        : (!ev.error ? h(Empty, { text: "公告（自选范围）与快讯均为空" }) : null)));
}

/** 结论详情弹层（点击"实验与结论"里的摘要 → 完整展示全部结构化字段） */
function ConclusionModal({ concl, onClose }) {
  const section = (title, arr) => arr && arr.length ? h("div", { style: { marginTop: 12 } },
    h("div", { style: { color: C.accent, fontSize: 11, fontWeight: 700, marginBottom: 4 } }, title),
    arr.map((x, i) => h("div", { key: i, style: { fontSize: 12, color: C.text, lineHeight: 1.65, marginBottom: 3 } }, `• ${x}`))) : null;
  return h("div", { onClick: onClose,
      style: { position: "fixed", inset: 0, zIndex: 9500, background: "rgba(31,39,51,0.45)", display: "flex", alignItems: "center", justifyContent: "center" } },
    h("div", { onClick: (e) => e.stopPropagation(),
      style: { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, maxWidth: 680, width: "92%", maxHeight: "78vh", overflow: "auto" } },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 10 } },
        h("span", { style: { fontSize: 15, fontWeight: 700, color: C.text } }, `结论 ${concl.id}`),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
          h(Badge, { text: concl.verdict, kind: concl.verdict === "validated" ? "ok" : concl.verdict === "rejected" ? "bad" : concl.verdict === "partially_validated" ? "warn" : "info" }),
          h("button", { onClick: onClose, style: { background: C.fill, border: `1px solid ${C.border}`, borderRadius: 6, padding: "2px 10px", cursor: "pointer", color: C.text } }, "✕"))),
      h("div", { style: { fontSize: 11, color: C.sub, marginBottom: 10 } },
        `${concl.experiment_id ? "实验 " + concl.experiment_id : "无实验"}` +
        `${concl.idea_id ? " · " + concl.idea_id : ""}` +
        `${concl.confidence ? " · 置信度 " + concl.confidence : ""}` +
        `${concl.created_at ? " · " + String(concl.created_at).replace("T", " ").slice(0, 16) : ""}`),
      h("div", { style: { fontSize: 13, color: C.text, lineHeight: 1.75, whiteSpace: "pre-wrap" } }, concl.summary),
      section("支撑证据", concl.supporting_evidence),
      section("局限", concl.limitations),
      section("适用条件", concl.applicable_conditions),
      section("失败条件", concl.failure_conditions),
      section("下一步实验", concl.next_experiments),
      concl.backtest_path ? h("div", { style: { marginTop: 12, fontSize: 11, color: C.sub } },
        `回测路径: ${concl.backtest_path}`) : null));
}

function Lab() {
  const [lab, setLab] = useState({ data: null, error: null });
  useEffect(() => {
    getJSON(`${API}/lab/list.json`).then((r) => setLab({ data: r, error: null }))
      .catch((e) => setLab({ data: null, error: String(e) }));
  }, []);
  const d = lab.data;
  const statusKind = (s) => ({ draft: "info", formalized: "info", testing: "warn", validated: "ok", rejected: "bad", archived: "info" }[s] || "info");
  const [selIdea, setSelIdea] = useState(null);
  const [selConcl, setSelConcl] = useState(null);
  // ---- 按选中 Idea 拆分实验/结论/策略版本 ----
  // 链路：Idea ← Signal(idea_id) ← Experiment(signal_id) ← Conclusion(experiment_id) / Strategy(strategy_id)
  // 直验结论（未走正式实验）用 Conclusion.idea_id 直接回链。
  const ideaId = selIdea ? selIdea.id : null;
  const sigIds = new Set(Object.values(d?.signals || {}).filter((s) => s && s.idea_id === ideaId).map((s) => s.id));
  const ideaExps = (d?.experiments || []).filter((e) => sigIds.has(e.signal_id));
  const expIds = new Set(ideaExps.map((e) => e.id));
  const ideaConcls = (d?.conclusions || []).filter((c) =>
    (c.experiment_id && expIds.has(c.experiment_id)) || (ideaId && c.idea_id === ideaId));
  const ideaStrats = Object.entries(d?.strategies || {})
    .filter(([id, s]) => ideaExps.some((e) => e.strategy_id === id) || (s && sigIds.has(s.signal_id)))
    .map(([id, s]) => ({ id, ...s }));
  const ideaSignals = Object.values(d?.signals || {}).filter((s) => s && s.idea_id === ideaId);
  return h(Fragment, null,
    selConcl ? h(ConclusionModal, { concl: selConcl, onClose: () => setSelConcl(null) }) : null,
    h("div", { style: { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" } },
    h(Card, { title: "假设池（点击行查看详情）", style: { flex: "1 1 420px" } },
      d ? h(Table, {
        columns: [
          { key: "id", label: "ID" }, { key: "title", label: "直觉/命题" },
          { key: "status", label: "状态", render: (r) => h(Badge, { text: r.status, kind: statusKind(r.status) }) },
        ],
        rows: d.ideas || [], rowKey: "id",
        selectedKey: selIdea ? selIdea.id : null,
        onRowClick: (r) => setSelIdea(r),
      }) : h(Empty, { text: lab.error ? `生命周期数据不可用 (${lab.error})` : "加载中…" })),
    h("div", { style: { flex: "1 1 340px", display: "flex", flexDirection: "column", gap: 12 } },
      // 假设详情（点选后展示）
      h(Card, { title: selIdea ? `假设详情 · ${selIdea.id}` : "假设详情" },
        selIdea ? h("div", { style: { fontSize: 12, display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { style: { fontSize: 14, fontWeight: 700, color: C.text } }, selIdea.title),
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
            h(Badge, { text: `状态: ${selIdea.status}`, kind: statusKind(selIdea.status) }),
            selIdea.verdict ? h(Badge, { text: `裁决: ${selIdea.verdict.result}`, kind: selIdea.verdict.result === "validated" ? "ok" : selIdea.verdict.result === "rejected" ? "bad" : "warn" }) : null,
            selIdea.source ? h(Badge, { text: `来源: ${selIdea.source}`, kind: "info" }) : null),
          selIdea.description ? h("div", { style: { color: C.text, lineHeight: 1.6 } }, selIdea.description) : null,
          selIdea.validation_summary ? h("div", { style: { background: C.fill, borderRadius: 6, padding: "6px 10px", color: C.sub, lineHeight: 1.6 } }, selIdea.validation_summary) : null,
          selIdea.verdict?.reason ? h("div", { style: { color: C.warn, lineHeight: 1.6 } }, `裁决依据: ${selIdea.verdict.reason}`) : null,
          (selIdea.tags || []).length ? h("div", { style: { color: C.sub } }, "标签: " + selIdea.tags.join("、")) : null)
          : h(Empty, { text: "点击左侧假设行查看详情" })),
      // 关联信号：Idea 形式化后的可执行命题（Signal.idea_id 回链 Idea，含 DSL 表达式）
      h(Card, { title: selIdea ? `关联信号 · ${selIdea.id}` : "关联信号" },
        d ? (ideaId
          ? (ideaSignals.length
            ? h("div", { style: { fontSize: 12, display: "flex", flexDirection: "column", gap: 8 } },
                ideaSignals.map((s) => h("div", { key: s.id, style: { display: "flex", flexDirection: "column", gap: 3 } },
                  h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                    h("span", { style: { fontWeight: 600, color: C.text } },
                      `${s.id}（v${s.version || "?"}）${s.name ? " · " + s.name : ""}`),
                    h(Badge, { text: s.frequency || "daily", kind: "info" })),
                  s.statement ? h("div", { style: { color: C.text, lineHeight: 1.5 } }, s.statement) : null,
                  s.expression ? h("div", { style: { color: C.sub, fontFamily: "monospace", fontSize: 11, background: C.fill, borderRadius: 6, padding: "6px 8px" } },
                    JSON.stringify(s.expression)) : null)))
            : h(Empty, { text: "该假设尚未形式化 Signal（可执行命题未落盘；初步验证记录见“假设详情”的 validation_summary）" }))
          : h(Empty, { text: "点击左侧假设行，查看该假设形式化后的信号" }))
          : h(Empty, { text: "加载中…" })),
      // 实验与结论：只展示与选中 Idea 关联的（Idea→Signal→Experiment→Conclusion）
      h(Card, { title: selIdea ? `实验与结论 · ${selIdea.id}` : "实验与结论" },
        d ? (ideaId
          ? (ideaExps.length || ideaConcls.length
            ? h("div", { style: { fontSize: 12, display: "flex", flexDirection: "column", gap: 6 } },
                h("div", { style: { color: C.sub } }, `关联实验 ${ideaExps.length} 个 · 关联结论 ${ideaConcls.length} 个`),
                ideaExps.map((e) => h("div", { key: e.id, style: { display: "flex", justifyContent: "space-between" } },
                  h("span", null, `${e.id} · ${e.purpose || "--"}`),
                  h(Badge, { text: e.status, kind: e.status === "completed" ? "ok" : "info" }))),
                ideaConcls.map((c) => h("div", { key: c.id, style: { display: "flex", flexDirection: "column", gap: 2 } },
                  h("div", { style: { display: "flex", justifyContent: "space-between" } },
                    h("span", null, c.id), h(Badge, { text: c.verdict, kind: c.verdict === "validated" ? "ok" : c.verdict === "rejected" ? "bad" : "warn" })),
                  c.summary ? h("div", { onClick: () => setSelConcl(c), title: "点击查看完整结论（含支撑证据/局限/适用条件/下一步）",
                      style: { color: C.sub, fontSize: 11, lineHeight: 1.5, cursor: "pointer" } },
                    c.summary.length > 120 ? c.summary.slice(0, 120) + "… " : c.summary,
                    c.summary.length > 120 ? h("span", { style: { color: C.accent, fontWeight: 600 } }, "展开 ▸") : null) : null)))
            : h(Empty, { text: "该假设尚未形式化 Signal→Experiment 链路，暂无关联实验/结论（初步验证记录见“假设详情”的 validation_summary）" }))
          : h(Empty, { text: "点击左侧假设行，查看该假设关联的实验与结论" }))
          : h(Empty, { text: "加载中…" })),
      // 策略版本：只展示与选中 Idea 关联的（经 Experiment.strategy_id 或 Strategy.signal_id）
      h(Card, { title: selIdea ? `策略版本 · ${selIdea.id}` : "策略版本" },
        d ? (ideaId
          ? (ideaStrats.length
            ? h("div", { style: { fontSize: 12, color: C.sub } },
                ideaStrats.map((s) => h("div", { key: s.id, style: { padding: "3px 0" } }, `${s.id}（v${s.version || "?"}）`)))
            : h(Empty, { text: "该假设暂无关联策略版本" }))
          : h(Empty, { text: "点击左侧假设行，查看该假设关联的策略版本" }))
          : h(Empty, { text: "加载中…" })))));
}


function CronPage() {
  const [tasks, setTasks] = useState(null);
  const [err, setErr] = useState(null);
  const reload = () => getJSON(`${API}/cron/tasks`).then((r) => setTasks(r.tasks)).catch((e) => setErr(String(e)));
  useEffect(() => { reload(); }, []);
  const act = (url) => getJSON(url).then(reload).catch((e) => setErr(String(e)));
  const fmtSched = (s) => s.type === "interval_minutes" ? `每 ${s.interval} 分钟`
    : (s.type === "daily_trading" ? "每交易日 " : "每天 ") + s.time;
  return h(Card, { title: "全局定时任务（dsh 进程内调度，交易日感知）" },
    err ? h(Empty, { text: "定时服务不可用: " + err })
    : !tasks ? h(Empty, { text: "加载中…" })
    : h(Table, {
        columns: [
          { key: "name", label: "任务" },
          { key: "schedule", label: "计划", render: (r) => fmtSched(r.schedule) + (r.tz ? ` (${r.tz})` : "") },
          { key: "last_status", label: "最近状态", render: (r) => r.last_run
              ? h(Badge, { text: (r.running ? "运行中" : r.last_status || "--") + (r.last_run ? " · " + r.last_run.slice(5, 16).replace("T", " ") : ""),
                          kind: r.running ? "info" : r.last_status === "success" ? "ok" : r.last_status === "failed" ? "bad" : "warn" })
              : h(Badge, { text: "未运行", kind: "info" }) },
          { key: "ops", label: "操作", render: (r) => h(Fragment, null,
              h("button", { onClick: () => act(`${API}/cron/run?id=${encodeURIComponent(r.id)}`),
                style: { background: C.fill, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12, marginRight: 8 } }, "立即运行"),
              h("button", { onClick: () => act(`${API}/cron/toggle?id=${encodeURIComponent(r.id)}&enabled=${!r.enabled}`),
                style: { background: "transparent", color: r.enabled ? C.warn : C.sub, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12 } },
                r.enabled ? "停用" : "启用")) },
        ],
        rows: tasks, rowKey: "id",
      }));
}

/* ============ 壳 ============ */

// ---- 分栏布局（看板打开时：侧边栏收到 shell 原生收起宽度 56px + 对话移右栏，看板居中） ----
// ---- 分栏布局（看板打开时：侧边栏收到 shell 原生收起宽度 56px + 对话移右栏，看板居中） ----
// grid 手术版（可靠）：直接设 grid 为 shell 原生收起值 "56px 1fr 0px"（比例一致）。
// shell 的 grid transition 激活时 inline 修改会卡旧值 → 先禁 transition。
// 双向绑定：联动轮询检测用户点 shell 收起按钮（state 展开→收起，按钮浮出 x<100）→ 关看板。
const SPLIT = { sidebar: 56, conversation: 520 };

function applySplitLayout() {
  const frame = document.querySelector(".pI_x6G_frame");
  if (!frame) return false;
  const sb = frame.querySelector(".pI_x6G_sidebarCol");
  const cc = frame.querySelector(".pI_x6G_centerCol");
  if (!sb || !cc) return false;
  if (!window.__tdLayoutOrig) {
    // 归一化：教师看板（teacher-calendar/portfolio）手术是 4 列 grid（sidebar calW 1fr details）
    // 且被动关闭时不恢复 → 交易接管时当前 grid 可能是教师残局，不能作为"打开前的原样"保存。
    const g = (frame.style.gridTemplateColumns || "").trim();
    const teacherResidue = g.split(/\s+/).filter(Boolean).length >= 4;
    window.__tdLayoutOrig = {
      wasCollapsed: sb.getBoundingClientRect().width < 100,
      grid: teacherResidue ? null : g,   // 残局 → null：restore 时重建默认（不信任旧值）
      cc: { pos: cc.style.position, r: cc.style.right, t: cc.style.top, b: cc.style.bottom, w: cc.style.width },
    };
  }
  frame.style.transition = "none";
  frame.style.gridTemplateColumns = `${SPLIT.sidebar}px minmax(0px, 1fr) 0px`;
  // 清掉教师看板留下的 gridColumn 残留（教师把 centerCol 推到第 3 列等）
  cc.style.gridColumn = "";
  sb.style.gridColumn = "";
  // 对话栏钉右
  cc.style.position = "fixed"; cc.style.right = "0"; cc.style.top = "0"; cc.style.bottom = "0";
  cc.style.width = `${SPLIT.conversation}px`;
  // 同步 shell state 为"收起"：让右上角按钮显示"展开侧边栏"（收起态浮出可见，用户可点）。
  // toggle.click 在挂载渲染期可能被吞 → 轮询重试，直到 state 收起或超时（失败则按钮被盖，用📈关闭兜底）
  if (!window.__tdLayoutOrig.wasCollapsed) {
    let tries = 0;
    window.__tdSyncState = setInterval(() => {
      tries += 1;
      const t = frame.querySelector(".hHd-Xa_toggle");
      if (t && t.getAttribute("aria-label") === "收起侧边栏") t.click();   // state 展开 → 点一次收起
      if (tries >= 15 || (t && t.getAttribute("aria-label") === "打开侧边栏")) {
        clearInterval(window.__tdSyncState);
      }
    }, 200);
  }
  return true;
}

function restoreSplitLayout(passive = false) {
  const o = window.__tdLayoutOrig;
  const frame = document.querySelector(".pI_x6G_frame");
  // 清理打开时的 syncState（避免关闭后仍在点 toggle 干扰恢复）
  if (window.__tdSyncState) { clearInterval(window.__tdSyncState); window.__tdSyncState = null; }
  if (o && frame) {
    const cc = frame.querySelector(".pI_x6G_centerCol");
    if (cc) {
      cc.style.position = o.cc.pos; cc.style.right = o.cc.r; cc.style.top = o.cc.t; cc.style.bottom = o.cc.b; cc.style.width = o.cc.w;
      cc.style.gridColumn = "";   // 清掉教师看板残留的 gridColumn 推移
    }
    if (passive) {
      // 被动关闭（教师看板抢占）：只复原我们动过的 centerCol，
      // 不动 grid / 不点 toggle —— 布局交接给新面板（教师看板会做自己的 grid 手术）。
      window.__tdLayoutOrig = null;
      return;
    }
    // 还原 grid（仅当打开时我们收起了侧边栏；transition 禁用态设置防卡旧值）。
    // 残局接管（o.grid == null）时教师已把侧边栏收起，无条件恢复默认展开布局。
    if (!o.wasCollapsed || o.grid == null) {
      frame.style.transition = "none";
      // orig.grid 可能在教师残局接管时被置 null → 重建 shell 默认布局（教师侧使用的同款默认）
      frame.style.gridTemplateColumns = o.grid || `280px minmax(0px, 1fr) 0px`;
      // 同步 shell state 为"展开"：打开时 syncState 把 state 收起了 → 关闭时展开，与 grid 280 一致
      const t = frame.querySelector(".hHd-Xa_toggle");
      if (t && t.getAttribute("aria-label") === "打开侧边栏") {
        let tries = 0;
        const syncExpand = setInterval(() => {
          tries += 1;
          const tb = frame.querySelector(".hHd-Xa_toggle");
          if (tb && tb.getAttribute("aria-label") === "打开侧边栏") tb.click();
          if (tries >= 15 || (tb && tb.getAttribute("aria-label") === "收起侧边栏")) clearInterval(syncExpand);
        }, 200);
      }
    }
  }
  window.__tdLayoutOrig = null;
}

const TABS = [
  ["overview", "大盘概览", Overview],
  ["sector", "板块", Sector],
  ["entity", "个股", Entity],
  ["folio", "组合", Folio],
  ["signals", "信号", Signals],
  ["news", "新闻", News],
  ["lab", "实验室", Lab],
  ["cron", "定时", CronPage],
];

export function DashboardApp({ onClose }) {
  const { date, error } = useLatest();
  const [tab, setTab] = useState("overview");
  // 分栏布局 + 守卫 + 双向绑定（合并为一个 effect）：
  // 挂载：applySplitLayout（grid 手术 + syncState 让 shell state 收起）
  // 轮询：①守卫维持分栏（React 重置则恢复）②联动（用户点 shell"展开侧边栏"上升沿 → 关看板）
  // 卸载（cleanup）：先停轮询（避免守卫与 restore 竞争把 grid 拉回 56），再 restore 还原展开
  useEffect(() => {
    applySplitLayout();
    let alive = true;
    let lastExpanded = null;
    const iv = setInterval(() => {
      if (!alive) return;
      // ---- 守卫：无条件重设分栏（React 重置则恢复） ----
      const f = document.querySelector(".pI_x6G_frame");
      if (f) {
        f.style.transition = "none";
        f.style.gridTemplateColumns = `${SPLIT.sidebar}px minmax(0px, 1fr) 0px`;
        const c = f.querySelector(".pI_x6G_centerCol");
        if (c) {
          c.style.position = "fixed"; c.style.right = "0"; c.style.top = "0"; c.style.bottom = "0";
          c.style.width = `${SPLIT.conversation}px`;
        }
      }
      // ---- 联动：用户点 shell"展开侧边栏"（state 收起→展开，aria 变"收起侧边栏"）→ 关闭看板 ----
      const t = document.querySelector(".pI_x6G_frame .hHd-Xa_toggle");
      if (!t) return;
      const isExpanded = t.getAttribute("aria-label") === "收起侧边栏";   // 展开态
      if (lastExpanded === null) { lastExpanded = isExpanded; return; }
      if (isExpanded && !lastExpanded) {
        window.dispatchEvent(new CustomEvent("td:close-dashboard"));
      }
      lastExpanded = isExpanded;
    }, 400);
    return () => {
      alive = false;
      clearInterval(iv);   // 先停守卫，避免与 restore 竞争
      const passive = !!window.__tdPassiveClose;   // 教师看板抢占 → 跳过 grid 恢复
      window.__tdPassiveClose = false;
      restoreSplitLayout(passive);
    };
  }, []);
  // 导航栈：程序跳转（股票/板块下钻）记录来源，目标页显示"← 返回"，可恢复来源页关键状态
  const [navStack, setNavStack] = useState([]);
  const goTab = (key) => { setNavStack([]); setTab(key); };   // 手动点页签：清空导航栈
  const pushNav = (to, params) => {
    const fromLabel = TABS.find((t) => t[0] === tab)?.[1] || "";
    setNavStack((s) => [...s, { from: tab, fromLabel, to, ...params }]);
    setTab(to);
  };
  const popNav = () => {
    setNavStack((s) => {
      if (!s.length) return s;
      const last = s[s.length - 1];
      // 恢复来源页关键状态（板块 → 重新选中跳转前的行业）
      if (last.from === "sector" && last.sectorTicker) {
        setSectorTarget({ ticker: last.sectorTicker, ts: Date.now() });
      }
      setTab(last.from);
      return s.slice(0, -1);
    });
  };
  // 全局个股跳转：任意页点击股票 → 切到个股页打开对应 K 线（ts 保证重复点击同一只也触发）
  const [entityTarget, setEntityTarget] = useState(null);
  const openEntity = (ticker, name = "", sectorTicker) => {
    setEntityTarget({ ticker, name, ts: Date.now() });
    pushNav("entity", { entityTicker: ticker, entityName: name, sectorTicker });
  };
  // 全局板块跳转：概览页行业榜点击 → 切到板块页并选中该行业
  const [sectorTarget, setSectorTarget] = useState(null);
  const openSector = (ticker) => {
    setSectorTarget({ ticker, ts: Date.now() });
    pushNav("sector", {});
  };
  // （热插拔版本轮询已移至 TradingButton/index.jsx——看板关闭时也保持自动刷新）
  const Page = TABS.find((t) => t[0] === tab)?.[2] || Overview;
  // 返回入口：栈顶来源页（仅程序跳转后存在）
  const back = navStack.length ? { label: navStack[navStack.length - 1].fromLabel, onBack: popNav } : null;
  // 各页共享的跳转能力（只接收自己需要的 props）
  const pageProps = { onOpenStock: openEntity, target: entityTarget, onOpenSector: openSector, sectorTarget, back };
  return h("div", { style: { position: "fixed", left: SPLIT.sidebar, right: SPLIT.conversation, top: 0, bottom: 0, zIndex: 9000, pointerEvents: "auto", background: C.bg, color: C.text, display: "flex", flexDirection: "column" } },
    h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "14px 20px", borderBottom: `1px solid ${C.border}` } },
      h("span", { style: { fontSize: 17, fontWeight: 700 } }, "交易看板"),
      TABS.map(([key, label]) => h("button", {
        key, onClick: () => goTab(key),
        style: {
          background: tab === key ? C.fillActive : "transparent", border: `1px solid ${tab === key ? C.accent : "transparent"}`,
          borderRadius: 8, color: tab === key ? C.text : C.sub, padding: "6px 12px", cursor: "pointer", fontSize: 13,
        },
      }, label)),
      h("span", { style: { marginLeft: "auto", fontSize: 12, color: C.sub } },
        date ? `数据日 ${date}（最近有数据）` : error ? `数据不可用: ${error}` : "管道未运行（暂无数据）"),
      h("button", { onClick: onClose, style: { background: C.fill, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 14px", cursor: "pointer" } }, "关闭")),
    h("div", { style: { flex: 1, overflow: "auto", padding: 16 } },
      h(Page, pageProps)));
}
