"""as_of 数据访问器：回测唯一数据入口。

原则（护栏文档 §3.1）：
- 价格类：只返回 index ≤ day 的行——物理隔离，未来行根本不存在于视图中
- 财报类：只返回 NOTICE_DATE ≤ day 的报告期（PIT 对齐，护栏 L1）
- 访问日志：视图记录每次取数的最大日期，供泄漏自检（护栏 §3.4）
"""
from __future__ import annotations

import pandas as pd


class AsOfView:
    """某一决策日的数据视图。策略代码只能拿到这个对象，拿不到完整容器。"""

    def __init__(self, day: pd.Timestamp, closes: pd.DataFrame, opens: pd.DataFrame,
                 financials: pd.DataFrame | None, access_log: list,
                 sector_closes: pd.DataFrame | None = None,
                 sector_amounts: pd.DataFrame | None = None):
        self._day = day
        self._closes = closes[closes.index <= day]   # 收盘价（NAV 计价）
        self._opens = opens[opens.index <= day]      # 开盘价（执行成交价）
        self._financials = financials
        self._log = access_log
        # 板块日线（板块轮动 DSL：sector_rank/sector_slope/amount_ratio/up_closes/drawdown_recovered）
        self._sector_closes = sector_closes[sector_closes.index <= day] if sector_closes is not None else None
        self._sector_amounts = sector_amounts[sector_amounts.index <= day] if sector_amounts is not None else None

    @property
    def day(self) -> pd.Timestamp:
        return self._day

    def prices(self) -> pd.DataFrame:
        """index ≤ day 的收盘价（date × symbol）。未来行物理不存在。"""
        self._log.append(("prices", self._day, self._day))
        return self._closes

    def sector_prices(self) -> pd.DataFrame | None:
        """index ≤ day 的板块收盘（date × sector_id）；未装载板块数据返回 None。"""
        if self._sector_closes is None:
            return None
        self._log.append(("sector_prices", self._day, self._day))
        return self._sector_closes

    def sector_amounts(self) -> pd.DataFrame | None:
        """index ≤ day 的板块成交额（date × sector_id）；未装载返回 None。"""
        if self._sector_amounts is None:
            return None
        self._log.append(("sector_amounts", self._day, self._day))
        return self._sector_amounts

    def close(self, symbol: str, day: pd.Timestamp | None = None) -> float:
        """指定日（默认决策日）收盘价；停牌日无行 → KeyError。"""
        d = day or self._day
        if d > self._day:
            raise KeyError(f"as_of 违规：试图读取未来日期 {d}（决策日 {self._day}）")
        return float(self._closes.loc[d, symbol])

    def financials(self, symbol: str, field: str) -> float | None:
        """最新披露日 ≤ 决策日的字段值（PIT）。无披露记录返回 None。"""
        self._log.append(("financials", self._day, self._day))
        if self._financials is None:
            return None
        rows = self._financials[
            (self._financials["symbol"] == symbol)
            & (self._financials["notice_date"] <= self._day)
        ]
        if rows.empty:
            return None
        latest = rows.sort_values("notice_date").iloc[-1]
        return float(latest[field])


class MarketData:
    """回测数据容器。策略代码永远接触不到本对象——engine 只把 AsOfView 交给策略。"""

    def __init__(self, closes: pd.DataFrame, opens: pd.DataFrame | None = None,
                 financials: pd.DataFrame | None = None,
                 sector_closes: pd.DataFrame | None = None,
                 sector_amounts: pd.DataFrame | None = None):
        """
        closes: 收盘价 DataFrame，index=交易日（升序 DatetimeIndex），columns=股票代码（hfq）
        opens:  开盘价 DataFrame（执行成交价），缺省时回退 closes（简化测试用）
        financials: DataFrame，columns 至少含 [symbol, report_period, notice_date, ...字段]
        sector_closes/sector_amounts: 板块日线（date × sector_id），板块轮动 DSL 用，可选
        """
        self.closes = closes.sort_index()
        self.opens = opens.sort_index() if opens is not None else self.closes.copy()
        self.financials = financials
        self.sector_closes = sector_closes.sort_index() if sector_closes is not None else None
        self.sector_amounts = sector_amounts.sort_index() if sector_amounts is not None else None
        self._log: list[tuple] = []

    def as_of(self, day: pd.Timestamp) -> AsOfView:
        return AsOfView(day, self.closes, self.opens, self.financials, self._log,
                        self.sector_closes, self.sector_amounts)

    def access_log(self) -> list[tuple]:
        return list(self._log)
