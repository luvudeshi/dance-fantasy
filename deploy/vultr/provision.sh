#!/usr/bin/env bash
# Creates the always-warm analysis worker on Vultr (app/vultr_worker.py explains why).
#
#   VULTR_API_KEY=... BLOB_READ_WRITE_TOKEN=... WORKER_DOMAIN=worker.dancefantasy.tech deploy/vultr/provision.sh
#
# Then: point WORKER_DOMAIN's A record at the printed IP, wait for https://$WORKER_DOMAIN/api/health, and set
# ANALYSIS_WORKER_URL=https://$WORKER_DOMAIN on the Vercel project (vercel env add ANALYSIS_WORKER_URL production).
# Region dfw (Dallas, closest to Austin and Vercel's US regions); plan vc2-2c-4gb (2 vCPU, 4 GB, about $20/month).
set -euo pipefail
: "${VULTR_API_KEY:?set VULTR_API_KEY}" "${BLOB_READ_WRITE_TOKEN:?set BLOB_READ_WRITE_TOKEN}" "${WORKER_DOMAIN:?set WORKER_DOMAIN}"
REGION="${VULTR_REGION:-dfw}"
PLAN="${VULTR_PLAN:-vc2-2c-4gb}"
OS_ID="${VULTR_OS_ID:-2284}"  # Ubuntu 24.04 LTS x64 (GET https://api.vultr.com/v2/os)
here="$(cd "$(dirname "$0")" && pwd)"
user_data="$(sed -e "s|__BLOB_READ_WRITE_TOKEN__|${BLOB_READ_WRITE_TOKEN}|" -e "s|__WORKER_DOMAIN__|${WORKER_DOMAIN}|" "$here/cloud-init.yaml" | base64 | tr -d '\n')"
api() { curl -fsS -H "Authorization: Bearer ${VULTR_API_KEY}" -H "Content-Type: application/json" "$@"; }

id="$(api -X POST https://api.vultr.com/v2/instances -d "{\"region\":\"${REGION}\",\"plan\":\"${PLAN}\",\"os_id\":${OS_ID},\"label\":\"dance-fantasy-worker\",\"hostname\":\"dance-fantasy-worker\",\"user_data\":\"${user_data}\",\"tags\":[\"dance-fantasy\"]}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["instance"]["id"])')"
echo "instance ${id} created; waiting for its IP..."
for _ in $(seq 1 60); do
  ip="$(api "https://api.vultr.com/v2/instances/${id}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["instance"]["main_ip"])')"
  [ "${ip}" != "0.0.0.0" ] && break
  sleep 5
done
echo "worker IP: ${ip}"
echo "next: A record ${WORKER_DOMAIN} -> ${ip}; then vercel env add ANALYSIS_WORKER_URL production  (value https://${WORKER_DOMAIN})"
