#!/bin/bash
# 热插拔验证脚本：dsh 重启一次后运行，确认桥接插件已加载（无需再重启）
# 用法：bash scripts/verify-hotplug.sh
set -e

echo "=== ① 桥接插件包已安装 ==="
PKG=/Users/bhn/.npm/_npx/6c7f445d1bf61956/node_modules/@bhn/teacher-calendar-bridge
if [ -f "$PKG/lib/client.js" ] && [ -f "$PKG/lib/index.js" ]; then
  echo "✅ 包就绪: $PKG"
else
  echo "❌ 包缺失，请先运行: node scripts/build-bridge.mjs --install"
  exit 1
fi

echo "=== ② cordis.patch.yml 注册与 HMR 启用 ==="
CFG=~/.dsh/profiles/web/cordis.patch.yml
grep -q "teacher-calendar-bridge" "$CFG" && echo "✅ 桥插件条目已注册" || echo "❌ 缺少桥插件条目"
grep -q "disabled: false" "$CFG" && echo "✅ HMR 已启用（覆盖 web-app 默认禁用）" || echo "❌ HMR 未启用"

echo "=== ③ DSH roster 是否包含桥插件（热插拔生效证据）==="
HTML=$(curl -s http://127.0.0.1:3080/ 2>/dev/null || true)
python3 - "$HTML" <<'PY'
import sys, json
html = sys.argv[1]

if not html.strip():
    print('❌ DSH (127.0.0.1:3080) 无响应或返回空 —— DSH 可能未启动，请先打开 DSH GUI')
    sys.exit(0)

tag = 'window.__DSH_BOOT__'
i = html.find(tag)
if i == -1:
    print('❌ 页面未找到 window.__DSH_BOOT__ —— DSH 版本可能不同或尚未就绪，稍后重试')
    sys.exit(0)

# 稳健提取：从赋值后的第一个 { 到 </script> 之间截取 JSON
start = html.find('{', i)
end = html.find('</script>', start)
if start == -1 or end == -1:
    print('❌ 无法定位 boot JSON 边界，DSH 页面结构异常')
    print('   片段:', repr(html[i:i+120]))
    sys.exit(0)

raw = html[start:end].strip().rstrip(';').strip()
try:
    boot = json.loads(raw)
except json.JSONDecodeError as e:
    print('❌ boot JSON 解析失败:', e)
    print('   片段(前200字):', raw[:200])
    sys.exit(0)

entries = boot.get('entries', [])
bridge = [e for e in entries if 'bridge' in e.get('id', '')]
if bridge:
    print('✅ bridge 已进入 roster:', json.dumps(bridge[0], ensure_ascii=False))
    print(f'   roster 共 {len(entries)} 个条目')
else:
    print('❌ bridge 未进入 roster —— dsh 可能尚未重启（HMR 无法热加载自己，需重启一次激活）')
    print('   重启方式：关闭 DSH GUI 后重新打开；或 launchctl 相关服务重启')
    print(f'   roster 共 {len(entries)} 个条目，含 bridge 关键字: 0')
PY

echo "=== ④ 日历独立应用健康 ==="
curl -s -o /dev/null -w "API 8787: %{http_code}\n" http://127.0.0.1:8787/api/calendar/bootstrap || echo "❌ API 未运行（cd teacher-calendar && npm run dev）"
curl -s -o /dev/null -w "Vite 5173: %{http_code}\n" http://localhost:5173/ || echo "❌ Vite 未运行（cd teacher-calendar && npm run dev:web）"

echo
echo "完成。若 ③ 显示 ✅，则热插拔已生效：以后改 cordis.patch.yml 增删插件、更新桥 bundle 均无需重启 dsh。"
