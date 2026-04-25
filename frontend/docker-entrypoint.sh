#!/bin/sh
set -eu

SSL_DIR="/etc/nginx/ssl"
CERT_FILE="$SSL_DIR/selfsigned.crt"
KEY_FILE="$SSL_DIR/selfsigned.key"

SSL_CERT_CN="${SSL_CERT_CN:-localhost}"
SSL_CERT_SAN="${SSL_CERT_SAN:-DNS:localhost,IP:127.0.0.1}"
SSL_CERT_EXTRA_IP="${SSL_CERT_EXTRA_IP:-}"

if [ -n "$SSL_CERT_EXTRA_IP" ]; then
  SSL_CERT_SAN="$SSL_CERT_SAN,IP:$SSL_CERT_EXTRA_IP"
fi

mkdir -p "$SSL_DIR"

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "Generating self-signed SSL certificate for CN=$SSL_CERT_CN SAN=$SSL_CERT_SAN"
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -subj "/CN=$SSL_CERT_CN" \
    -addext "subjectAltName=$SSL_CERT_SAN"
fi

exec nginx -g "daemon off;"
