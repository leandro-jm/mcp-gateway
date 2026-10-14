#!/usr/bin/env bash
# Builds the mcp-gateway images (gateway, crawler, admin-ui) and publishes them to Docker Hub as public,
# multi-arch images. With --local it only builds for the native platform and loads them as :local,
# to try the production compose before publishing.
#
# Usage:
#   scripts/docker-publish.sh [--local] [--only gateway|crawler|admin-ui] [--no-latest] [--allow-dirty]
#
# Environment:
#   DOCKERHUB_NAMESPACE  Docker Hub user or org (default: leandrojm)
#   VERSION              image version (default: "version" of the root package.json)
#   PLATFORMS            buildx platforms for publish (default: linux/amd64,linux/arm64)
#   DOCKERHUB_TOKEN      optional personal access token with the 'Read, Write, Delete' scope: creates missing
#                        repositories as public (a 'Read & Write' token only pushes; the push then creates them)
#   DOCKERHUB_USERNAME   account that owns DOCKERHUB_TOKEN (default: DOCKERHUB_NAMESPACE)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NAMESPACE="${DOCKERHUB_NAMESPACE:-leandrojm}"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="mcp-gateway"
SOURCE_URL="https://github.com/leandro-jm/mcp-gateway"

MODE=publish
ONLY=""
LATEST=1
ALLOW_DIRTY=0

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --local) MODE=local ;;
    --only) ONLY="${2:-}"; shift ;;
    --no-latest) LATEST=0 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

# name | repository | dockerfile | build args | description (Docker Hub, <= 100 chars)
IMAGES=(
  "gateway|mcp-gateway|docker/node-app.Dockerfile|APP=gateway|MCP gateway: exposes REST/OpenAPI APIs as MCP tools (data plane + Admin API)"
  "crawler|mcp-gateway-crawler|docker/node-app.Dockerfile|APP=crawler|mcp-gateway worker: OpenAPI discovery, tool generation and drift detection"
  "admin-ui|mcp-gateway-admin-ui|docker/admin-ui.Dockerfile|VITE_ENV_LABEL=PROD|mcp-gateway Admin UI (nginx, proxies /admin and /mcp to the gateway)"
)
if [ -n "$ONLY" ]; then
  case "$ONLY" in gateway | crawler | admin-ui) ;; *) die "--only must be gateway, crawler or admin-ui" ;; esac
fi

# ---------- pre-checks ----------
command -v docker >/dev/null || die "docker not found"
docker buildx version >/dev/null 2>&1 || die "docker buildx not available"
[[ "$NAMESPACE" =~ ^[a-z0-9]{4,30}$ ]] || die "invalid Docker Hub namespace: $NAMESPACE (lowercase letters and digits)"

if grep -q "link:\.\./\.\./\.\./" pnpm-lock.yaml; then
  die "pnpm-lock.yaml links packages outside the repo (e.g. ../mcp-ui-kit); they are not in the Docker build context. Use the published npm versions."
fi

REVISION="$(git rev-parse HEAD)"
SHORT_SHA="$(git rev-parse --short=7 HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  if [ "$ALLOW_DIRTY" = 1 ]; then
    warn "working tree has uncommitted changes; sha-$SHORT_SHA will not match the image contents"
  elif [ "$MODE" = publish ]; then
    die "working tree has uncommitted changes (commit them or pass --allow-dirty)"
  fi
fi

# Prints the Docker Hub credentials of `docker login` as JSON ({"Username","Secret"}), from config.json or its
# credential helper. Prints nothing when there are none.
dockerhub_credentials() {
  local config="${DOCKER_CONFIG:-$HOME/.docker}/config.json" store
  [ -f "$config" ] || return 0
  store="$(node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const e = (c.auths || {})["https://index.docker.io/v1/"] || {};
    if (e.auth) {
      const [u, ...s] = Buffer.from(e.auth, "base64").toString().split(":");
      console.log(JSON.stringify({ Username: u, Secret: s.join(":") }));
    } else process.stdout.write("helper:" + ((c.credHelpers || {})["index.docker.io"] || c.credsStore || ""));
  ' "$config")"
  case "$store" in
    helper:) ;;
    helper:*)
      store="${store#helper:}"
      command -v "docker-credential-$store" >/dev/null &&
        echo "https://index.docker.io/v1/" | "docker-credential-$store" get 2>/dev/null || true
      ;;
    *) echo "$store" ;;
  esac
}

# Fails early (before a long multi-arch build) when the login cannot push to $NAMESPACE/<repo>.
check_push_access() {
  local repo="$1" creds user token actions
  creds="$(dockerhub_credentials)"
  [ -n "$creds" ] || die "not logged in to Docker Hub: run docker login -u $NAMESPACE with a personal access token (scope 'Read & Write')"
  user="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).Username || "")' "$creds")"
  token="$(
    node -e 'const c = JSON.parse(process.argv[1]); process.stdout.write(`user = "${c.Username}:${c.Secret}"\n`)' "$creds" |
      curl -sS -K - "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$NAMESPACE/$repo:pull,push" |
      node -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).token || "") } catch {}'
  )"
  [ -n "$token" ] || die "Docker Hub rejected the stored login of '$user': run docker login -u $NAMESPACE again"
  actions="$(node -e '
    const p = JSON.parse(Buffer.from(process.argv[1].split(".")[1], "base64url").toString());
    process.stdout.write((p.access || []).flatMap((a) => a.actions || []).join(","));
  ' "$token")"
  case ",$actions," in
    *,push,*) echo "==> Docker Hub login '$user' can push to $NAMESPACE/$repo" ;;
    *) die "Docker Hub login '$user' cannot push to $NAMESPACE/$repo (granted: ${actions:-none}). Log in as $NAMESPACE with a personal access token whose scope is 'Read & Write' or 'Read, Write, Delete' (the default 'Public Repo Read-only' cannot push): docker logout && docker login -u $NAMESPACE" ;;
  esac
}

if [ "$MODE" = publish ]; then
  for entry in "${IMAGES[@]}"; do
    IFS='|' read -r name repo _ <<<"$entry"
    if [ -z "$ONLY" ] || [ "$ONLY" = "$name" ]; then check_push_access "$repo"; fi
  done
  if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    echo "==> creating buildx builder '$BUILDER' (docker-container driver, needed for multi-arch)"
    docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
  fi
fi

# ---------- Docker Hub repositories (public) ----------
HUB_JWT=""
if [ "$MODE" = publish ] && [ -n "${DOCKERHUB_TOKEN:-}" ]; then
  HUB_JWT="$(
    node -e 'process.stdout.write(JSON.stringify({identifier:process.argv[1],secret:process.env.DOCKERHUB_TOKEN}))' \
      "${DOCKERHUB_USERNAME:-$NAMESPACE}" |
      curl -fsS -X POST https://hub.docker.com/v2/auth/token -H 'Content-Type: application/json' --data-binary @- |
      node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).access_token)'
  )" || die "Docker Hub authentication failed (check DOCKERHUB_USERNAME / DOCKERHUB_TOKEN)"
fi

ensure_public_repo() {
  local repo="$1" description="$2" status private body
  if [ -z "$HUB_JWT" ]; then
    return 0
  fi
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' \
    -H "Authorization: Bearer $HUB_JWT" "https://hub.docker.com/v2/namespaces/$NAMESPACE/repositories/$repo")"
  if [ "$status" = 200 ]; then
    private="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).is_private' "$body")"
    rm -f "$body"
    [ "$private" = true ] && warn "$NAMESPACE/$repo is PRIVATE on Docker Hub; make it public in its Settings (the API has no visibility endpoint)"
    return 0
  fi
  rm -f "$body"
  if [ "$status" = 401 ] || [ "$status" = 403 ]; then
    warn "Docker Hub refused to read $NAMESPACE/$repo (HTTP $status); skipping the repository check"
    HUB_CREATE_DENIED=1
    return 0
  fi
  [ "$status" = 404 ] || die "Docker Hub returned HTTP $status for $NAMESPACE/$repo"
  echo "==> creating public repository $NAMESPACE/$repo"
  body="$(mktemp)"
  status="$(
    node -e '
      const [ns, name, description, readme] = process.argv.slice(1);
      const full = require("fs").readFileSync(readme, "utf8");
      process.stdout.write(JSON.stringify({ namespace: ns, name, description, full_description: full, registry: "docker.io", is_private: false }));
    ' "$NAMESPACE" "$repo" "$description" docker/dockerhub/README.md |
      curl -sS -o "$body" -w '%{http_code}' -X POST "https://hub.docker.com/v2/namespaces/$NAMESPACE/repositories" \
        -H "Authorization: Bearer $HUB_JWT" -H 'Content-Type: application/json' --data-binary @-
  )"
  case "$status" in
    200 | 201) ;;
    401 | 403)
      # A "Read & Write" PAT can push but not manage repositories; the push below creates the repo instead
      warn "Docker Hub refused to create $NAMESPACE/$repo (HTTP $status: $(head -c 200 "$body")). The token needs the 'Read, Write, Delete' scope for that; continuing, the push creates it with your account's default visibility"
      HUB_CREATE_DENIED=1
      ;;
    *)
      rm -f "$body"
      die "could not create $NAMESPACE/$repo on Docker Hub (HTTP $status)"
      ;;
  esac
  rm -f "$body"
}
HUB_CREATE_DENIED=0

# ---------- tags ----------
tags_for() {
  local ref="$1"
  if [ "$MODE" = local ]; then
    echo "$ref:local"
    return
  fi
  echo "$ref:$VERSION"
  echo "$ref:sha-$SHORT_SHA"
  if [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "$ref:${VERSION%.*}"
    if [ "$LATEST" = 1 ]; then echo "$ref:latest"; fi
  fi
}

# ---------- build ----------
CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PUBLISHED=()
for entry in "${IMAGES[@]}"; do
  IFS='|' read -r name repo dockerfile build_arg description <<<"$entry"
  [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && continue
  ref="$NAMESPACE/$repo"

  args=(--file "$dockerfile" --build-arg "$build_arg")
  while read -r tag; do args+=(--tag "$tag"); done < <(tags_for "$ref")
  args+=(
    --label "org.opencontainers.image.title=$repo"
    --label "org.opencontainers.image.description=$description"
    --label "org.opencontainers.image.source=$SOURCE_URL"
    --label "org.opencontainers.image.url=https://hub.docker.com/r/$ref"
    --label "org.opencontainers.image.version=$VERSION"
    --label "org.opencontainers.image.revision=$REVISION"
    --label "org.opencontainers.image.created=$CREATED"
    --label "org.opencontainers.image.licenses=Apache-2.0"
  )
  if [ "$MODE" = publish ]; then
    ensure_public_repo "$repo" "$description"
    args+=(--builder "$BUILDER" --platform "$PLATFORMS" --provenance=mode=max --sbom=true --push)
  else
    args+=(--load)
  fi

  echo "==> $name → $ref ($MODE)"
  docker buildx build "${args[@]}" .
  PUBLISHED+=("$ref")
done

echo
if [ "$MODE" = local ]; then
  echo "Built (native platform):"
  for ref in "${PUBLISHED[@]}"; do echo "  $ref:local"; done
  echo
  echo "Try the stack: IMAGE_NAMESPACE=$NAMESPACE TAG=local docker compose -f docker/docker-compose.prod.yml --env-file <your .env> up -d"
else
  echo "Published ($PLATFORMS):"
  for ref in "${PUBLISHED[@]}"; do tags_for "$ref" | sed 's/^/  /'; done
  if [ -z "$HUB_JWT" ] || [ "$HUB_CREATE_DENIED" = 1 ]; then
    warn "repositories created by the push use your account's default visibility; check they are public at https://hub.docker.com/u/$NAMESPACE"
  fi
  echo
  echo "Check: docker buildx imagetools inspect $NAMESPACE/mcp-gateway:$VERSION"
fi
