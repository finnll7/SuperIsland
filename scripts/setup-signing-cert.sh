#!/bin/bash
# 创建用于本地代码签名的自签名证书（一次性）。
# 使 TCC 权限(日历/辅助功能)能持久关联到应用，避免 ad-hoc 签名每次构建失效。
set -euo pipefail

WORK="/tmp/superisland-signing"
mkdir -p "$WORK"
cd "$WORK"

cat > sign.conf <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = SuperIsland Local Signing
O = SuperIsland
[v3]
basicConstraints = critical, CA:TRUE
keyUsage = critical, digitalSignature, keyCertSign
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
EOF

echo "==> 生成私钥与自签名证书..."
openssl genrsa -out sign.key 2048 2>/dev/null
openssl req -new -x509 -key sign.key -out sign.crt -days 3650 -config sign.conf

echo "==> 创建 p12..."
openssl pkcs12 -export -out sign.p12 -inkey sign.key -in sign.crt -passout pass:signpass -legacy

echo "==> 导入 Keychain..."
security import sign.crt -k ~/Library/Keychains/login.keychain-db
security import sign.p12 -k ~/Library/Keychains/login.keychain-db -P signpass -T /usr/bin/codesign

echo "==> 设置证书信任..."
security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db sign.crt

echo "==> 确认..."
security find-identity -v -p codesigning | grep "SuperIsland Local Signing" || {
  echo "错误: 证书未就绪"; exit 1
}
echo "==> 完成。现在可运行 scripts/sign-local.sh 签名应用。"