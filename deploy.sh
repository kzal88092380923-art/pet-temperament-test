#!/usr/bin/env bash
# 반려동물테스트 배포 스크립트
# 화이트리스트 파일만 dist/로 복사해 배포 → main/ 안의 다른 프로젝트 폴더가 절대 딸려가지 않음
# Draft 배포 → 경로 검증 통과 시에만 Production 승격 (netlify deploy --prod Forbidden 우회)
set -euo pipefail

SITE_ID="c0914fb9-c95a-4497-b901-288680c67bbc"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
FUNCTIONS_DIR="$SCRIPT_DIR/netlify/functions"

# 배포할 정적 파일 (새 파일을 배포하려면 여기에 명시적으로 추가해야 함)
WHITELIST=(
  index.html
  quiz.html
  dashboard.html
  og-image.png
  sitemap.xml
  robots.txt
  _redirects
)

MUST_BE_404=(/hub/ /nutrifit/ /child-mbti/ /CLAUDE.md /deploy.sh /netlify.toml /dist/)
MUST_BE_200=(/quiz.html "/quiz.html?st=check&v=3" /sitemap.xml /robots.txt /og-image.png)
# 루트는 서버에서 quiz.html로 301 (쿼리스트링·리퍼러 유지) — "요청경로 기대Location" 쌍
MUST_BE_301=("/?utm_source=deploycheck /quiz.html?utm_source=deploycheck" "/index.html /quiz.html")

cd "$SCRIPT_DIR"

if ! netlify status >/dev/null 2>&1; then
  echo "✗ Netlify 로그인이 필요합니다:  netlify login"
  exit 1
fi

echo "▶ dist/ 구성 (화이트리스트)"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
for f in "${WHITELIST[@]}"; do
  if [ ! -f "$SCRIPT_DIR/$f" ]; then
    echo "✗ 화이트리스트 파일 없음: $f"
    exit 1
  fi
  cp "$SCRIPT_DIR/$f" "$DIST_DIR/"
  echo "  + $f"
done

echo "▶ Draft 배포 시작..."
DEPLOY_JSON=$(netlify deploy --dir="$DIST_DIR" --functions="$FUNCTIONS_DIR" --site="$SITE_ID" --json)
DEPLOY_ID=$(printf '%s' "$DEPLOY_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('deploy_id') or d.get('id') or '')")
DRAFT_URL=$(printf '%s' "$DEPLOY_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('deploy_url') or d.get('url') or '')")

if [ -z "$DEPLOY_ID" ] || [ -z "$DRAFT_URL" ]; then
  echo "✗ Deploy 정보 추출 실패. 원본:"
  printf '%s\n' "$DEPLOY_JSON"
  exit 1
fi
echo "✓ Draft 완료  ID: $DEPLOY_ID"
echo "  URL: $DRAFT_URL"

echo "▶ Draft 경로 검증"
FAILED=0
check() {
  local path="$1" expected="$2" code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$DRAFT_URL$path")
  if [ "$code" = "$expected" ]; then
    echo "  ✓ $path → $code"
  else
    echo "  ✗ $path → $code (기대값 $expected)"
    FAILED=1
  fi
}
for p in "${MUST_BE_404[@]}"; do check "$p" 404; done
for p in "${MUST_BE_200[@]}"; do check "$p" 200; done
# 이미지 프록시 거부 경로 (외부 호출 없이 함수가 즉시 400 반환)
check "/api/img" 400
check "/api/img?u=https://evil.com/x" 400
for pair in "${MUST_BE_301[@]}"; do
  read -r p want <<< "$pair"
  out=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "$DRAFT_URL$p")
  if [ "${out%% *}" = "301" ] && [[ "${out#* }" == *"$want" ]]; then
    echo "  ✓ $p → 301 $want"
  else
    echo "  ✗ $p → $out (기대값 301 …$want)"
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "✗ 검증 실패 — Production 승격하지 않음 (draft만 남음)"
  exit 1
fi

echo "▶ Production 승격 중..."
netlify api restoreSiteDeploy \
  --data "{\"site_id\":\"$SITE_ID\",\"deploy_id\":\"$DEPLOY_ID\"}" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f\"✓ Production 승격 완료 (state: {d.get('state', '?')})\")
print(f\"🚀 Live: {d.get('ssl_url') or d.get('url', '?')}\")
"
