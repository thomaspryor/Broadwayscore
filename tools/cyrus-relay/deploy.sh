#!/usr/bin/env bash
# Deploy helper for the Cyrus relay. Reads VERCEL_TOKEN from the main repo .env.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${CYRUS_RELAY_ENV_FILE:-$HOME/Broadwayscore/.env}"
VERCEL_TOKEN="$(grep '^VERCEL_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
export VERCEL_TOKEN
SCOPE=thomaspryors-projects
PROJECT=cyrus-relay

cd "$HERE"

case "${1:-deploy}" in
  link)
    vercel link --yes --project "$PROJECT" --scope "$SCOPE" --token "$VERCEL_TOKEN"
    ;;
  deploy)
    vercel deploy --prod --yes --scope "$SCOPE" --token "$VERCEL_TOKEN"
    ;;
  *)
    echo "usage: deploy.sh [link|deploy]" >&2
    exit 2
    ;;
esac
