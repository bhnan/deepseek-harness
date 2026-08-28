/**
 * @bhn/apps-proxy — DSH 反向代理插件。
 *
 * 把 DSH webServer 上的路径代理到本机独立服务：
 *   /calendar/*     → http://127.0.0.1:8787/*   （教师教学工作日历）
 *   /portfolio/*    → http://127.0.0.1:8797/*   （学生成长档案）
 *
 * 前端构建时使用 base=/calendar/ 与 base=/portfolio/，
 * 所以页面资源请求是 /calendar/assets/... 与 /portfolio/assets/...，
 * 代理时去掉前缀即可原样转发到目标服务（目标服务在根路径提供页面与 API）。
 */

import { request } from "node:http";

const name = "apps-proxy";
const inject = ["webServer"];

const PROXIES = [
  { prefix: "/calendar", target: { host: "127.0.0.1", port: 8787 } },
  { prefix: "/portfolio", target: { host: "127.0.0.1", port: 8797 } },
];

function apply(ctx) {
  ctx.effect(() => {
    const ws = ctx.webServer;
    if (!ws) {
      ctx.logger.warn("[apps-proxy] webServer not available");
      return;
    }

    const disposers = PROXIES.map(({ prefix, target }) =>
      ws.register({
        kind: "prefix",
        path: prefix,
        handler: async (req, res) => {
          const url = new URL(req.url ?? "/", "http://x");
          // 去掉前缀（/calendar/xxx → /xxx；/calendar → /）
          const rest = url.pathname.slice(prefix.length) || "/";
          const targetUrl = rest + (url.search ? url.search : "");

          const headers = { ...req.headers };
          delete headers.host;
          headers.host = `${target.host}:${target.port}`;

          const proxyReq = request(
            {
              host: target.host,
              port: target.port,
              path: targetUrl,
              method: req.method,
              headers,
            },
            (proxyRes) => {
              res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
              proxyRes.pipe(res);
            },
          );

          proxyReq.on("error", (err) => {
            ctx.logger.warn("[apps-proxy] proxy error:", err.message);
            if (!res.headersSent) {
              res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: "apps-proxy: upstream unreachable", detail: err.message }));
            } else {
              res.destroy();
            }
          });

          req.pipe(proxyReq);
        },
      }),
    );

    ctx.logger.info(`[apps-proxy] routes registered: ${PROXIES.map((p) => p.prefix).join(", ")}`);

    return () => {
      disposers.forEach((d) => d());
      ctx.logger.info("[apps-proxy] routes disposed");
    };
  });
}

export { apply, inject, name };
export default { apply, inject, name };
