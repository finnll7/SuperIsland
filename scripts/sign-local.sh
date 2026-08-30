#!/bin/bash
# 用自签名证书给本地构建的 SuperIsland.app 签名。
# ad-hoc 签名每次构建 CDHash 变化会导致 TCC 权限(日历/辅助功能)失效，
# 用固定证书签名可让 TCC 授权持久。每次 xcodebuild 后运行本脚本。
set -euo pipefail

APP="${1:-build/DerivedData/Build/Products/Release/SuperIsland.app}"
CERT_NAME="SuperIsland Local Signing"

if [ ! -d "$APP" ]; then
  echo "错误: 找不到 $APP"
  exit 1
fi

# 找到自签名证书
CERT_ID="$(security find-identity -v -p codesigning 2>/dev/null | grep "$CERT_NAME" | awk -F'"' '{print $2}' | head -1)"
if [ -z "$CERT_ID" ]; then
  echo "错误: 未找到自签名证书 \"$CERT_NAME\"。请先运行 scripts/setup-signing-cert.sh"
  exit 1
fi

echo "==> 签名 $APP (证书: $CERT_NAME)"
codesign --force --sign "$CERT_ID" --deep --options runtime \
  --entitlements "SuperIsland/SuperIsland.entitlements" "$APP"
codesign --verify --deep --strict "$APP" && echo "==> 签名验证通过"
echo "==> 完成"