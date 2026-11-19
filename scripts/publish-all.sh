#!/usr/bin/env bash
# 把仓库里每个可发布的包都发到 npm。tag 上跑一次就是全量发布。
#
#   bash scripts/publish-all.sh                  # 真发布
#   bash scripts/publish-all.sh --dry-run        # 只看选中了哪些包，不上传
#
# 额外参数原样传给 npm publish（workflow 传 --provenance --access public）。
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [ -n "${NPM_TOKEN:-}" ]; then
	printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" >"$HOME/.npmrc"
	echo "authenticating with NPM_TOKEN"
else
	echo "no NPM_TOKEN; relying on trusted publishing (OIDC)"
fi

published=0
skipped=0
failed=0

while IFS= read -r manifest; do
	manifest="${manifest#./}"
	dir="$(dirname "$manifest")"
	name="$(node -p "try{require('./$manifest').name||''}catch(e){''}" 2>/dev/null)"
	if [ -z "$name" ]; then
		echo "skip $dir: no name"
		skipped=$((skipped + 1))
		continue
	fi
	if [ "$(node -p "require('./$manifest').private===true")" = "true" ]; then
		echo "skip $dir ($name): private"
		skipped=$((skipped + 1))
		continue
	fi
	version="$(node -p "require('./$manifest').version||''")"
	if [ -z "$version" ]; then
		echo "skip $dir ($name): no version"
		skipped=$((skipped + 1))
		continue
	fi
	if npm view "$name@$version" version >/dev/null 2>&1; then
		echo "skip $dir ($name@$version): already on npm"
		skipped=$((skipped + 1))
		continue
	fi
	echo "publish $dir ($name@$version)"
	if (cd "$dir" && npm publish "$@"); then
		published=$((published + 1))
	else
		echo "FAILED $dir ($name@$version)"
		failed=$((failed + 1))
	fi
done < <(find . -name package.json -not -path '*/node_modules/*' -not -path './.git/*' | sort)

echo "published=$published skipped=$skipped failed=$failed"
[ "$failed" -eq 0 ]
