#!/bin/sh
# One-time: create a persistent self-signed code-signing identity so TCC
# grants survive rebuilds.
#
# Ad-hoc signing (codesign --sign -) gives the app a designated requirement
# that IS the binary's hash: every rebuild is a different app to TCC and the
# microphone grant dies with it (measured 2026-08-26 — the menu bar rebuild
# silently killed voice). With a stable certificate the requirement becomes
# "this bundle id, signed by this cert", which survives any rebuild.
#
# macOS will show one keychain authorization dialog for the trust step —
# that is you telling the OS to accept this cert for code signing. Run once:
#   sh lib/mac/make-signing-identity.sh
set -e
NAME="rewalk signing"

if security find-identity -v -p codesigning | grep -q "$NAME"; then
  echo "identity \"$NAME\" already exists; nothing to do"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/ext.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = rewalk signing
[v3]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/ext.cnf" >/dev/null 2>&1
# system LibreSSL: Homebrew's OpenSSL 3 emits PKCS12 the macOS keychain rejects
/usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$NAME" -passout pass:rewalk -out "$TMP/id.p12" >/dev/null 2>&1

KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
security import "$TMP/id.p12" -k "$KEYCHAIN" -P rewalk -T /usr/bin/codesign >/dev/null
# The dialog this triggers is the one-time trust decision.
security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"

security find-identity -v -p codesigning | grep "$NAME" && echo "identity ready: \"$NAME\""
