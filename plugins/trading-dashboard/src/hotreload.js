/** 热插拔-lite：监听 client 源码变化 → 自动 rebuild → 版本号 +1 → 客户端轮询发现后自动刷新页面。
 *  边界说明（诚实）：只覆盖 client（页面/渲染器）；host 侧 Node 代码（路由/cron/logger）仍须重启 dsh 生效。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function startHotReload({ pluginDir, log, onBuilt }) {
  const watchDir = path.join(pluginDir, "src", "client");
  let timer = null;
  let building = false;

  const runBuild = () => {
    building = true;
    log.info("hotreload: 检测到 client 源码变化，rebuild 中");
    const child = spawn(process.execPath, ["build.mjs"], { cwd: pluginDir });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      building = false;
      log.info(`hotreload: rebuild 完成 code=${code}`, { output: out.trim().slice(-300) });
      if (code === 0) {
        // 浏览器加载的是 profile node_modules 里的拷贝 → 同步过去（__dirname 在拷贝内）
        try {
          fs.copyFileSync(path.join(pluginDir, "client.js"), path.join(__dirname, "..", "client.js"));
        } catch (e) {
          log.warn("hotreload: 拷贝到 profile 失败（若浏览器未更新请重跑安装脚本）", String(e));
        }
        onBuilt();   // 版本 +1 → 客户端自动刷新
      }
    });
  };

  let watcher = null;
  try {
    watcher = fs.watch(watchDir, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!building) runBuild();
      }, 600);   // 防抖：连续保存只触发一次
    });
    log.info("hotreload: 已监听", { dir: watchDir });
  } catch (e) {
    log.warn("hotreload: 监听失败（热插拔关闭）", String(e));
  }
  return () => watcher && watcher.close();
}

module.exports = { startHotReload };
