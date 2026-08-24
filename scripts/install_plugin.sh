#!/bin/bash
# 安装/更新 DSH 交易看板插件到 ~/.dsh/profiles/web/
# ⚠️ 需重启 dsh 生效（client 插件注册在启动时装载）。执行后请重启 DSH 并在
# http://127.0.0.1:3080 侧栏底部查看 📈 按钮。
# ⚠️ pnpm 的 file: 依赖是"拷贝"而非链接：修改插件源码后必须重跑本脚本再重启 dsh。
set -euo pipefail

PLUGIN_DIR="/Users/bhn/Desktop/funny_project/trading/plugins/trading-dashboard"
PROFILE_DIR="$HOME/.dsh/profiles/web"
PLUGIN_NAME="@bhn/trading-dashboard"

echo "== 0/6 构建 client 包 =="
cd "$PLUGIN_DIR"
node build.mjs
node --check client.js

echo "== 1/6 写入 profile 依赖 =="
cd "$PROFILE_DIR"
python3 - "$PLUGIN_NAME" "$PLUGIN_DIR" <<'EOF'
import json, sys
name, path = sys.argv[1], sys.argv[2]
pkg = json.load(open("package.json"))
deps = pkg.setdefault("dependencies", {})
deps[name] = f"file:{path}"
json.dump(pkg, open("package.json", "w"), indent=2, ensure_ascii=False)
print(f"package.json 依赖已加: {name} → {deps[name]}")
EOF

echo "== 2/6 pnpm 安装 =="
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --silent
else
  echo "本机未安装 pnpm，通过 npx 临时获取（首次需联网，约 10s）"
  npx --yes pnpm install --silent
fi

echo "== 3/6 强制同步插件源码（pnpm file: 依赖不自动重拷） =="
TARGET="$PROFILE_DIR/node_modules/@bhn/trading-dashboard"
rm -rf "$TARGET"
mkdir -p "$(dirname "$TARGET")"
cp -R "$PLUGIN_DIR" "$TARGET"
rm -rf "$TARGET/node_modules"   # 插件自带工具链（esbuild/zod）不进 profile
echo "已同步: $TARGET"

echo "== 4/6 cordis.patch.yml 注册条目 =="
python3 - "$PLUGIN_NAME" <<'EOF'
import sys
name = sys.argv[1]
patch = open("cordis.patch.yml").read()
entry = f'- insert:\n    - id: trading-dashboard\n      name: "{name}"\n'
if "trading-dashboard" in patch:
    print("已存在注册条目，跳过")
else:
    open("cordis.patch.yml", "a").write("\n# 交易看板插件（host 数据路由 + client 页面）\n" + entry)
    print("已追加注册条目")
EOF

echo "== 5/6 完成 =="
echo "请重启 dsh 使插件生效（client 插件在启动时装载）。"
echo "重启后侧栏底部出现 📈 按钮，点击打开看板覆盖层。"
echo "回滚：删除 cordis.patch.yml 中 trading-dashboard 条目 + package.json 依赖，再 pnpm install。"
