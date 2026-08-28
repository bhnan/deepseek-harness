// tc CLI · HTTP 信封客户端（零依赖，Node ≥18 内置 fetch）
// 只与两个应用的 REST API 通信；业务校验/原子写/撤销栈全部留在服务端。

export const DEFAULT_BASES = {
  calendar: 'http://127.0.0.1:8787',
  portfolio: 'http://127.0.0.1:8797',
};
// bases 为 origin；API 前缀在此统一拼接，命令层只写资源路径
const API_PREFIX = { calendar: '/api/calendar', portfolio: '/api/portfolio' };
const DEFAULT_TIMEOUT_MS = 15000;

export class TcError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'TcError';
    this.code = code; // USAGE | RESOLVE_NOT_FOUND | RESOLVE_AMBIGUOUS | VALIDATION | SERVICE_DOWN | UPSTREAM_ERROR | PARSE_ERROR
    if (detail !== undefined) this.detail = detail;
  }
}

/** 错误码 → 进程退出码（spec §2） */
export function exitCodeOf(err) {
  switch (err?.code) {
    case 'USAGE': return 2;
    case 'SERVICE_DOWN': return 4;
    case 'RESOLVE_AMBIGUOUS': return 5;
    default: return 3; // UPSTREAM_ERROR / VALIDATION / PARSE_ERROR / RESOLVE_NOT_FOUND
  }
}

export function envelopeFromError(err) {
  const envelope = {
    ok: false,
    error: { code: err?.code || 'UPSTREAM_ERROR', message: String(err?.message || err) },
  };
  if (err?.detail !== undefined) envelope.error.detail = err.detail;
  if (err?.upstream !== undefined) envelope.error.upstream = err.upstream;
  return envelope;
}

/**
 * 构造 API 客户端。bases 可被参数覆盖，顺序：显式参数 > 环境变量 > 默认。
 * 环境变量：TC_CALENDAR_API / TC_PORTFOLIO_API
 */
export function makeApi(overrides = {}) {
  const bases = {
    calendar: overrides.calendar || process.env.TC_CALENDAR_API || DEFAULT_BASES.calendar,
    portfolio: overrides.portfolio || process.env.TC_PORTFOLIO_API || DEFAULT_BASES.portfolio,
  };
  let counter = 0;

  async function call(app, path, { method = 'GET', body, timeoutMs } = {}) {
    const t0 = Date.now();
    const url = `${bases[app]}${API_PREFIX[app]}${path}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const why = e?.name === 'AbortError' ? `超时（${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）`
        : e?.cause?.code || e?.message || '未知网络错误';
      throw new TcError('SERVICE_DOWN', `无法连接${app === 'calendar' ? '教学日历' : '学生档案'}服务（${bases[app]}）：${why}`);
    }
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = undefined; }
    if (json === undefined || json === null || typeof json !== 'object' || json.ok === undefined) {
      throw new TcError('UPSTREAM_ERROR', `${app} 服务返回非契约响应（HTTP ${res.status}）：${text.slice(0, 160)}`, { status: res.status, path });
    }
    if (json.ok === false) {
      const err = new TcError('UPSTREAM_ERROR', json.reason || json.message || `服务端拒绝（HTTP ${res.status}）`, { status: res.status, path });
      err.upstream = json;
      err.httpStatus = res.status;
      throw err;
    }
    return { ...json, _meta: { app, path, status: res.status, latency_ms: latencyMs, seq: ++counter } };
  }

  return { bases, call };
}
