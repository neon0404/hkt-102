#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

HOST="${DEPLOY_HOST:-root@kb-dev.ru}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/kb_ed25519}"
KNOWN_HOSTS="${DEPLOY_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
PORT="${DEPLOY_REGISTRY_PORT:-5005}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-https://smm.kb-dev.ru/api/v1/health}"
IMAGE=ai-marketer:latest
PUSH_TAG="localhost:$PORT/ai-marketer:latest"
REMOTE_TAG="127.0.0.1:$PORT/ai-marketer:latest"
TUNNEL=ai-marketer-tunnel
TUNNEL_IMAGE=ai-marketer-tunnel:1

hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
step() { printf '\n== %s\n' "$*"; }
close_tunnel() { docker rm -f "$TUNNEL" >/dev/null 2>&1 || true; }
trap close_tunnel EXIT

step "Сборка $IMAGE"
docker build --platform linux/amd64 -t "$IMAGE" .

step "SSH-туннель к реестру (localhost:$PORT)"
printf 'FROM alpine:3.20\nRUN apk add --no-cache openssh-client\n' | docker build -q -t "$TUNNEL_IMAGE" - >/dev/null
close_tunnel
docker run -d --rm --name "$TUNNEL" --network host \
  -v "$(hostpath "$KEY"):/key:ro" -v "$(hostpath "$KNOWN_HOSTS"):/known_hosts:ro" \
  "$TUNNEL_IMAGE" sh -c "install -m 600 /key /tmp/k && exec ssh -i /tmp/k -o IdentitiesOnly=yes -o UserKnownHostsFile=/known_hosts -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -N -L $PORT:127.0.0.1:$PORT $HOST" >/dev/null
for i in $(seq 1 30); do
  if docker exec "$TUNNEL" wget -qO- "http://127.0.0.1:$PORT/v2/" >/dev/null 2>&1; then break; fi
  if [ "$i" = 30 ] || ! docker ps -q --filter "name=^$TUNNEL\$" | grep -q .; then
    docker logs "$TUNNEL" 2>&1 | tail -5 || true
    echo "Туннель к реестру не поднялся" >&2
    exit 1
  fi
  sleep 1
done

step "Push $PUSH_TAG"
docker tag "$IMAGE" "$PUSH_TAG"
docker push "$PUSH_TAG"
docker rmi "$PUSH_TAG" >/dev/null 2>&1 || true
close_tunnel

step "Выкатка на $HOST"
scp -i "$KEY" -o IdentitiesOnly=yes docker-compose.yml "$HOST:/opt/ai-marketer/docker-compose.yml"
ssh -i "$KEY" -o IdentitiesOnly=yes "$HOST" "set -e
docker pull $REMOTE_TAG
docker tag $REMOTE_TAG ai-marketer:latest
cd /opt/ai-marketer
docker compose up -d
docker image prune -f
docker exec ai-marketer-registry bin/registry garbage-collect --delete-untagged /etc/docker/registry/config.yml >/dev/null 2>&1 || true"

step "Проверка $HEALTH_URL"
for i in $(seq 1 30); do
  if body=$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null); then
    echo "$body"
    exit 0
  fi
  sleep 3
done
echo "Health-check не прошёл: $HEALTH_URL" >&2
exit 1
