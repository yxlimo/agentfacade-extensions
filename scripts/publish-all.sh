#!/usr/bin/env bash
# 打包 + 把每个包发到 npm。tag 上跑一次就是全量发布。
#
#   bash scripts/publish-all.sh                  # 真发布
#   bash scripts/publish-all.sh --dry-run        # 只看选中了哪些包，不上传
#
# 额外参数原样传给 npm publish（workflow 传 --provenance --access public）。
#
# 发布的是 .build/ 里的 tarball，不是仓库目录：仓库里的适配器用 `../../core/x.ts`
# 引用共用代码，直接发出去会指向包外面。build-package.mjs 负责把 core 内联并改写。
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# 本机 ~/.npmrc 可能指向国内镜像，镜像不收发布（实测这里默认就是 registry.npmmirror.com）。
# 钉住官方 registry：查重与发布都用它，不受用户默认配置影响。
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
if [ -n "${NPM_TOKEN:-}" ]; then
	printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" >"$HOME/.npmrc"
	echo "authenticating with NPM_TOKEN"
else
	echo "no NPM_TOKEN; relying on trusted publishing (OIDC)"
fi

hosts=()
for dir in hosts/*/; do
	[ -f "$dir/package.json" ] && hosts+=("$(basename "$dir")")
done
if [ "${#hosts[@]}" -eq 0 ]; then
	echo "no packages under hosts/" >&2
	exit 1
fi

echo "building ${hosts[*]}"
if ! node scripts/build-package.mjs "${hosts[@]}" >/dev/null; then
	echo "build failed" >&2
	exit 1
fi

# 从 tarball 里读 package.json：发的就是它，不是仓库里那份。
field() {
	tar xzOf "$1" package/package.json | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=j[process.argv[1]];console.log(v===undefined?"":String(v))})' "$2"
}

published=0
skipped=0
failed=0

for tgz in .build/*.tgz; do
	[ -f "$tgz" ] || continue
	name="$(field "$tgz" name)"
	version="$(field "$tgz" version)"
	if [ -z "$name" ] || [ -z "$version" ]; then
		echo "skip $tgz: no name/version"
		skipped=$((skipped + 1))
		continue
	fi
	if [ "$(field "$tgz" private)" = "true" ]; then
		echo "skip $name: private"
		skipped=$((skipped + 1))
		continue
	fi
	if npm view --registry "$REGISTRY" "$name@$version" version >/dev/null 2>&1; then
		echo "skip $name@$version: already on npm"
		skipped=$((skipped + 1))
		continue
	fi
	echo "publish $name@$version ($tgz)"
	if npm publish --registry "$REGISTRY" "$tgz" "$@"; then
		published=$((published + 1))
	else
		echo "FAILED $name@$version"
		failed=$((failed + 1))
	fi
done

echo "published=$published skipped=$skipped failed=$failed"
[ "$failed" -eq 0 ]
