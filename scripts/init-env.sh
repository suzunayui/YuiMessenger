#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
DOMAIN="${1:-m.yuiroom.net}"
APP_NAME="YuiMessenger"
DB_NAME="yuimessenger"
DB_USER="yuimessenger"

if [[ -f "${ENV_FILE}" ]]; then
  echo ".env already exists: ${ENV_FILE}"
  echo "Remove it first if you want to regenerate secrets."
  exit 1
fi

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n' | tr '/+' '_-' | cut -c1-48
    return
  fi

  python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(36))
PY
}

DB_PASSWORD="$(generate_secret)"

cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
POSTGRES_DB=${DB_NAME}
POSTGRES_USER=${DB_USER}
POSTGRES_PASSWORD=${DB_PASSWORD}
DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@db:5432/${DB_NAME}
RP_ID=${DOMAIN}
RP_NAME=${APP_NAME}
EXPECTED_ORIGIN=https://${DOMAIN}
EOF

echo "Created ${ENV_FILE}"
echo "Domain: ${DOMAIN}"
echo "A strong database password was generated automatically."
