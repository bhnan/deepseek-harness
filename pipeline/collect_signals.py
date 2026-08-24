"""A13 策略信号：DSL 策略执行 + legacy 策略列示。

v1（DSL 接入）：
- 读 lab/strategies 注册表；有顶层 expression 的策略视为 DSL 策略
- 板块轮动策略：加载板块日线（data/sector/sw_daily.parquet）→ as_of 视图 →
  对 31 板块评估疲劳/修复 DSL → 疲劳榜 × 修复榜配对（打分 + 冷却）→ 写入
  derived.constituents（配对候选板块）/ change_pct（候选当日等权涨跌）/ performance_curve
- 冷却：data/signals/cooldown.json，同对 5 个交易日内不重复发出（v002 pairing.cooldown_days）
"""
import json
from pathlib import Path

from .io import write_asset

LAB_ROOT = Path(__file__).resolve().parent.parent / "lab"
STRATEGIES_INDEX = LAB_ROOT / "strategies" / "index.json"
DATA_ROOT = Path(__file__).resolve().parent.parent / "data"
SECTOR_DAILY = DATA_ROOT / "sector" / "sw_daily.parquet"
SECTOR_INFO = DATA_ROOT / "sector" / "sw_l1_info.json"
COOLDOWN_FILE = DATA_ROOT / "signals" / "cooldown.json"

DEFAULT_PAIRING = {"emit_top_k": 3, "cooldown_days": 5,
                   "fatigue_score_min": 0.65, "repair_score_min": 0.55}


def list_strategies() -> list[dict]:
    """读取 lab/strategies 注册表，返回 [{strategy_id, strategy_name, version, has_dsl, path}]。"""
    if not STRATEGIES_INDEX.exists():
        return []
    ids = json.loads(STRATEGIES_INDEX.read_text(encoding="utf-8")).get("strategies", [])
    out = []
    for sid in ids:
        base = LAB_ROOT / "strategies" / sid / "versions"
        versions = sorted([d.name for d in base.iterdir() if d.is_dir()]) if base.exists() else []
        latest = versions[-1] if versions else None
        sj = None
        if latest:
            sj_path = base / latest / "strategy.json"
            sj = json.loads(sj_path.read_text(encoding="utf-8")) if sj_path.exists() else None
        out.append({
            "strategy_id": sid,
            "strategy_name": sj.get("strategy_schema", {}).get("identity", {}).get("name", sid) if sj else sid,
            "version": latest,
            "has_dsl": bool(sj and sj.get("expression")),
            "definition": sj,
        })
    return out


# ---------------- 板块轮动 DSL 扫描 ----------------

def load_sector_data() -> tuple:
    """板块日线 → (closes, amounts, names, last_date)。
    closes/amounts: date × code；names: code → 名称。数据缺失返回 (None,)*3。"""
    if not SECTOR_DAILY.exists():
        return None, None, None, None
    import pandas as pd
    df = pd.read_parquet(SECTOR_DAILY)
    df["日期"] = pd.to_datetime(df["日期"])
    names = {}
    if SECTOR_INFO.exists():
        try:
            info = json.loads(SECTOR_INFO.read_text(encoding="utf-8"))
            for r in info.get("industries", []):
                code = str(r.get("行业代码", "")).replace(".SI", "")
                if code:
                    names[code] = r.get("行业名称") or code
        except Exception:
            names = {}
    closes = df.pivot_table(index="日期", columns="code", values="收盘", aggfunc="last").sort_index()
    amounts = df.pivot_table(index="日期", columns="code", values="成交额", aggfunc="last").sort_index()
    # 统一代码为 str（与 DSL universe 一致，避免 int/str 列名不匹配导致指标 NaN）
    for frame in (closes, amounts):
        frame.columns = frame.columns.astype(str)
    return closes, amounts, names, df["日期"].max()


def _load_cooldowns() -> dict:
    if COOLDOWN_FILE.exists():
        try:
            return json.loads(COOLDOWN_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_cooldowns(cd: dict) -> None:
    COOLDOWN_FILE.parent.mkdir(parents=True, exist_ok=True)
    COOLDOWN_FILE.write_text(json.dumps(cd, ensure_ascii=False, indent=1), encoding="utf-8")


def _score_pairs(fatigue: list, repair: list, pairing: dict, cooldown: dict,
                 last_date: str, strategy_id: str) -> list[dict]:
    """疲劳榜 × 修复榜配对：pair_score = fatigue * repair，top k，冷却排除。"""
    k = int(pairing.get("emit_top_k", 3))
    cooldown_days = int(pairing.get("cooldown_days", 5))
    f_min = float(pairing.get("fatigue_score_min", 0.65))
    r_min = float(pairing.get("repair_score_min", 0.55))
    pairs = []
    cool = cooldown.get(strategy_id, {})
    for f in fatigue:
        if f["score"] < f_min:
            continue
        for r in repair:
            if r["code"] == f["code"]:
                continue
            if r["score"] < r_min:
                continue
            key = f"{f['code']}|{r['code']}"
            emit = cool.get(key)
            if emit:
                import datetime
                try:
                    d1 = datetime.date.fromisoformat(str(last_date)[:10])
                    d2 = datetime.date.fromisoformat(str(emit)[:10])
                    if (d1 - d2).days < cooldown_days:
                        continue
                except Exception:
                    continue
            pairs.append({"old": f, "new": r, "key": key,
                          "pair_score": round(f["score"] * r["score"], 4)})
    pairs.sort(key=lambda p: p["pair_score"], reverse=True)
    return pairs[:k]


# ---------------- DSL 规则翻译（人类可读，写入 signals.json 供前端直接展示） ----------------

DSL_METRIC_CN = {
    "sector_rank": lambda a: f"{a.get('window', 1)}日收益分位（1=最强）",
    "sector_slope": lambda a: f"{a.get('window', 1)}日动量斜率",
    "amount_ratio": lambda a: f"{a.get('window', 1)}日放量比",
    "up_closes": lambda a: f"{a.get('window', 1)}日阳线数",
    "drawdown_recovered": lambda a: f"{a.get('window', 1)}日回撤修复",
    "slope_decay": lambda a: f"{a.get('fast', 5)}日斜率 < {a.get('slow', 20)}日斜率（动量衰减）",
    "slope_repair": lambda a: f"{a.get('fast', 5)}日斜率 > {a.get('slow', 20)}日斜率（动量拐头）",
}
DSL_OP_CN = {">=": "≥", "<=": "≤", ">": ">", "<": "<", "==": "=", "!=": "≠"}


def dsl_to_text(expr) -> str:
    """DSL 表达式 → 人类可读中文（策略规则透明化；原始 JSON 见 lab 策略定义）。"""
    if not expr:
        return ""
    if expr.get("operator"):
        parts = [dsl_to_text(c) for c in expr.get("conditions", [])]
        if expr["operator"] == "AND":
            return " 且 ".join(p for p in parts if p)
        if expr["operator"] == "OR":
            return " 或 ".join(p for p in parts if p)
        return f"非({parts[0] if parts else ''})"
    metric = expr.get("metric")
    m = DSL_METRIC_CN.get(metric)
    if not m:
        return f"{metric} ?"
    # 布尔指标（slope_decay/slope_repair）的 "== 1" 省略（描述本身即条件）
    if metric in ("slope_decay", "slope_repair") and expr.get("op") == "==" and expr.get("value") == 1:
        return f"{m(expr.get('args') or {})}"
    op = DSL_OP_CN.get(expr.get("op"), expr.get("op"))
    return f"{m(expr.get('args') or {})} {op} {expr.get('value')}"


def dsl_rules_of(defn: dict) -> dict:
    """策略定义 → 规则文本（fatigue/repair/pairing），供前端展示。"""
    pairing = {**DEFAULT_PAIRING, **(defn.get("pairing") or {})}
    rules = {}
    if defn.get("expression"):
        rules["fatigue"] = dsl_to_text(defn["expression"])
    if defn.get("repair_expression"):
        rules["repair"] = dsl_to_text(defn["repair_expression"])
    if pairing.get("emit_top_k"):
        rules["pairing"] = (f"疲劳分×修复分 top{pairing['emit_top_k']}，"
                            f"同对 {pairing.get('cooldown_days', 5)} 日冷却，"
                            f"疲劳分≥{pairing.get('fatigue_score_min')}、"
                            f"修复分≥{pairing.get('repair_score_min')}")
    return rules


def run_sector_rotation_scan(defn: dict, trading_date: str) -> dict:
    """板块轮动策略扫描：返回 derived（constituents/change_pct/signal_note/performance_curve）。"""
    import pandas as pd

    from backtest.data import MarketData
    from backtest.dsl import evaluate

    closes, amounts, names, last_date = load_sector_data()
    if closes is None or closes.empty:
        return {"signal_note": "板块日线数据缺失（sw_daily.parquet 未采集），无法扫描"}

    expr = defn.get("expression")
    repair_expr = defn.get("repair_expression")
    pairing = {**DEFAULT_PAIRING, **(defn.get("pairing") or {})}
    # as_of 决策日：指定交易日（在数据范围内则用），否则回落最后一天
    as_of_day = closes.index[-1]
    try:
        ts = pd.Timestamp(trading_date)
        if ts in closes.index:
            as_of_day = ts
        elif ts > closes.index[-1]:
            as_of_day = closes.index[-1]
    except Exception:
        pass
    md = MarketData(pd.DataFrame(index=closes.index), sector_closes=closes,
                    sector_amounts=amounts)
    view = md.as_of(as_of_day)
    universe = [str(c) for c in closes.columns]

    def evaluate_expr(e):
        from backtest.dsl import validate
        validate(e)
        return {s: evaluate(e, view, s, universe) for s in universe}

    fatigue_hits = evaluate_expr(expr) if expr else {}
    repair_hits = evaluate_expr(repair_expr) if repair_expr else {}

    def rank_of(code, window=20):
        from backtest.dsl import _sector_leaf_value
        return _sector_leaf_value({"metric": "sector_rank", "args": {"window": window}},
                                  view, str(code))

    fatigue = [{"code": c, "name": names.get(c, c), "score": round(rank_of(c), 4)}
               for c, hit in fatigue_hits.items() if hit and rank_of(c) == rank_of(c)]
    repair = [{"code": c, "name": names.get(c, c), "score": round(1.0 - rank_of(c), 4)}
              for c, hit in repair_hits.items() if hit and rank_of(c) == rank_of(c)]
    fatigue.sort(key=lambda x: x["score"], reverse=True)
    repair.sort(key=lambda x: x["score"], reverse=True)

    cooldown = _load_cooldowns()
    pairs = _score_pairs(fatigue, repair, pairing, cooldown, last_date, defn["strategy_id"])

    # 更新冷却（发出的配对记录当日）
    if pairs:
        cool = cooldown.setdefault(defn["strategy_id"], {})
        for p in pairs:
            cool[p["key"]] = str(last_date)[:10]
        _save_cooldowns(cooldown)

    constituents = [{"symbol": p["new"]["code"], "name": p["new"]["name"],
                     "weight": round(p["pair_score"], 4)} for p in pairs]
    # 当日表现：配对候选（新端）当日 vs 前一日 等权涨跌 %（时间维收益，观察值非持仓收益）
    change_pct = None
    pos = closes.index.get_loc(as_of_day)
    if pairs and pos > 0:
        prev_day = closes.index[pos - 1]
        vals = []
        for p in pairs:
            c = p["new"]["code"]
            if c in closes.columns:
                cur, prev = float(closes.loc[as_of_day, c]), float(closes.loc[prev_day, c])
                if prev:
                    vals.append(cur / prev - 1.0)
        if vals:
            change_pct = round(float(pd.Series(vals).mean()) * 100, 2)

    note = (f"DSL 已执行 · 疲劳榜 {len(fatigue)} · 修复榜 {len(repair)} · 配对 {len(pairs)} 组"
            f"（top{len(pairs)}，冷却 {pairing['cooldown_days']} 日）")
    if pairs:
        note += "；候选: " + "、".join(f"{p['old']['name']}→{p['new']['name']}" for p in pairs)
    derived = {"signal_note": note, "constituents": constituents, "dsl_status": "executed",
               "dsl_rules": dsl_rules_of(defn)}
    if change_pct is not None:
        derived["change_pct"] = change_pct
    return derived


def collect_signals(trading_date: str) -> Path:
    """A13：启用策略的当日快照。DSL 策略执行扫描，legacy 策略列示。"""
    strategies = []
    for s in list_strategies():
        entry = {"strategy_id": s["strategy_id"], "strategy_name": s["strategy_name"]}
        derived = {}
        if s["has_dsl"] and s["definition"]:
            try:
                derived = run_sector_rotation_scan(s["definition"], trading_date)
            except Exception as e:
                derived = {"signal_note": f"DSL 扫描失败: {e}", "dsl_status": "error"}
        else:
            derived["signal_note"] = "legacy 结构，无 DSL 表达式（表现字段缺席，不伪造）"
        entry["derived"] = derived
        strategies.append(entry)

    if not strategies:
        return write_asset("signals", trading_date,
                           {"status": "disabled", "scanned_count": 0, "strategies": []})
    return write_asset("signals", trading_date,
                       {"status": "scanned", "scanned_count": len(strategies),
                        "strategies": strategies},
                       data_quality={"note": "v1：DSL 策略扫描输出候选板块与表现"})


def collect_index_daily(trading_date: str) -> Path:
    """A3：五个指数日线（sparkline 与组合基准用）。全量重写 parquet。"""
    import akshare as ak
    import pandas as pd

    from .io import DATA_ROOT

    frames = []
    for code in ["sh000001", "sz399001", "sz399006", "sh000300", "sh000905"]:
        df = ak.stock_zh_index_daily(symbol=code)
        df["code"] = code
        frames.append(df[["code", "date", "open", "high", "low", "close", "volume"]])
    path = DATA_ROOT / "market" / "index_daily.parquet"
    path.parent.mkdir(parents=True, exist_ok=True)
    pd.concat(frames, ignore_index=True).to_parquet(path, index=False)
    return path
