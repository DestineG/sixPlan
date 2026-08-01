#!/bin/sh
set -eu
umask 077

: "${FRP_SERVER_ADDR:?FRP_SERVER_ADDR is required}"
: "${FRP_SERVER_PORT:=7000}"
: "${FRP_AUTH_TOKEN:?FRP_AUTH_TOKEN is required}"

cat > /tmp/frpc.toml <<EOF
serverAddr = "${FRP_SERVER_ADDR}"
serverPort = ${FRP_SERVER_PORT}

auth.method = "token"
auth.token = "${FRP_AUTH_TOKEN}"
transport.tls.enable = true

[[proxies]]
name = "sixplan-http-challenge"
type = "tcp"
localIP = "gateway"
localPort = 80
remotePort = 80

[[proxies]]
name = "sixplan-https"
type = "tcp"
localIP = "gateway"
localPort = 443
remotePort = 443
EOF

exec frpc -c /tmp/frpc.toml
