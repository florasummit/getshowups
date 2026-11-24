#!/usr/bin/env bash
# Releases one APPROVED PR the established way: CI green → captures → merge pinned to the reviewed head → wait for the
# deployment → live responses unchanged → refusals → records and secret NAMES unchanged → logs across one cron run.
# Read-only except the merge. Never migrates, never touches secrets, sends nothing. Prints the rollback deployment id.
# Usage: scripts/release.sh <pr> <full head sha>      Exit 0 = healthy; anything else = look before going on.
set -u
cd "$(dirname "$0")/.."
PR=$1 HEAD=$2 B=https://getshowups.com
D=$(mktemp -d)
PAGES="p/poolthru-llc api/receptionist/poolthru-llc book/poolthru-llc api/receptionist/getshowups chat/poolthru-llc chat/getshowups api/receptionist/gsu-stripe-test-pools"
bad=0
norm() { sed -E 's/data-cfemail="[^"]*"//g;s/email-protection#[0-9a-f]*//g;s/\/assets\/[A-Za-z0-9_-]+\.(js|css)//g' "$1"; }
counts() {
  npx wrangler d1 execute getshowups-onboarding --remote --json --command "SELECT (SELECT count(*) FROM customers) customers,(SELECT count(*) FROM leads) leads,(SELECT count(*) FROM appointments) appts,(SELECT count(*) FROM subscriptions) subs,(SELECT count(*) FROM ad_campaigns) ads,(SELECT group_concat(customer||enabled) FROM receptionist_settings) recept,(SELECT provider FROM receptionist_voice_defaults ORDER BY version DESC LIMIT 1) voice,(SELECT count(*) FROM sqlite_master WHERE type='table') tables" 2>/dev/null | tr -d '\n ' | grep -o '"results":\[.*\],"success'
  npx wrangler pages secret list --project-name getshowups 2>/dev/null | grep -oE '[A-Z_]{5,}' | sort | shasum
}
code() { local want=$1 name=$2; shift 2; local got; got=$(curl -s -o /dev/null -w '%{http_code}' "$@"); [ "$got" = "$want" ] && echo "ok   $name $got" || { echo "BAD  $name $got (want $want)"; bad=1; }; }
scripts/ci-check.sh "$PR" || { echo "CI is not green"; exit 1; }
scripts/gh.sh pr view "$PR" --json headRefOid,mergeStateStatus,baseRefName | tee "$D/pr"; echo
grep -q "$HEAD" "$D/pr" && grep -q '"CLEAN"' "$D/pr" && grep -q '"main"' "$D/pr" || { echo "not the reviewed head, not clean, or not into main"; exit 1; }
counts > "$D/before"; grep -q results "$D/before" || { echo "cannot read production counts"; exit 1; }
for p in $PAGES; do curl -s "$B/$p" -o "$D/1-${p//\//_}"; done
scripts/gh.sh pr merge "$PR" --merge --match-head-commit "$HEAD" || exit 1
M=$(git ls-remote origin main | cut -c1-40)
for _ in $(seq 1 40); do curl -s $B/build.json | grep -q "$M" && break; sleep 8; done
curl -s $B/build.json | grep -q "$M" || { echo "deployment of $M not seen"; exit 1; }
npx wrangler pages deployment list --project-name getshowups --environment production --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);require("fs").writeFileSync(process.argv[1],d[0].Id);console.log("main",process.argv[2].slice(0,7),"deployment",d[0].Id,"rollback",d[1].Id)})' "$D/dep" "$M"
(perl -e 'alarm 330; exec @ARGV' npx wrangler pages deployment tail "$(cat "$D/dep")" --project-name getshowups --environment production --format json > "$D/tail" 2>&1 &)
sleep 6
for p in $PAGES; do f=${p//\//_}; curl -s "$B/$p" -o "$D/2-$f"; diff <(norm "$D/1-$f") <(norm "$D/2-$f") >/dev/null && echo "same $p" || { echo "DIFF $p"; bad=1; }; done
J='Content-Type: application/json'
code 200 'booking times' $B/api/book/poolthru-llc
code 200 'enrollment' $B/api/enrollment
code 401 'dashboard signed out' $B/api/dashboard/me
code 401 'platform signed out' $B/api/platform/overview
code 401 'writing help signed out' -X POST $B/api/dashboard/write -H "$J" -H "Origin: $B" -d '{}'
code 403 'chat cross-site' -X POST $B/api/receptionist/poolthru-llc/chat -H "$J" -H 'Origin: https://evil.example' -d '{"text":"hi"}'
code 404 'forged conversation' -X POST $B/api/receptionist/poolthru-llc/chat -H "$J" -H "Origin: $B" -d '{"text":"hi","conversationId":"AAAAAAAAAAAAAAAA","token":"bad"}'
for _ in $(seq 1 66); do grep -q cron/run "$D/tail" && break; sleep 5; done; sleep 4
echo "logs: ok $(grep -c '"outcome": *"ok"' "$D/tail") · exceptions $(grep -c '"exceptions": *\[[^]]' "$D/tail") · errors $(grep -c '"level": *"error"' "$D/tail") · cron $(grep -c cron/run "$D/tail")"
[ "$(grep -c '"exceptions": *\[[^]]' "$D/tail")" = 0 ] || bad=1
counts > "$D/after"; cmp -s "$D/before" "$D/after" && echo 'records and secret names unchanged' || { echo 'CHANGED (real activity, or a problem):'; diff "$D/before" "$D/after"; }
[ $bad = 0 ] && echo HEALTHY || echo 'CHECK FAILED: look, and roll back to the id above if critical'
exit $bad
