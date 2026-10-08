#!/bin/sh
set -eu
umask 077

if [ ! -f "$AI_GATEWAY_CONFIG" ]; then
  cp /app/config/container.example.yaml "$AI_GATEWAY_CONFIG"
fi

exec node /app/dist/cli.js start --config "$AI_GATEWAY_CONFIG"
