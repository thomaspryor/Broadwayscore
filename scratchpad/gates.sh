cd ~/Broadwayscore
out=/tmp/claude-501/gates6.log
: > $out
run(){ echo "===== $* =====" >> $out; "$@" >> $out 2>&1; echo "EXIT=$? :: $*" >> $out; }
run node scripts/audit-outlet-registry.js --strict
run node scripts/audit-critic-outlets.js --strict
run node --test scripts/lib/merge-reviews-json.test.mjs
run node scripts/audit-contradicted-flag-basis.js --gate --max=0
run node scripts/audit-cv-flag-contradiction.js --window=30 --strict
run node --test scripts/audit-self-contradictory-clear-drained.test.mjs
run node scripts/test-temporal-override-regression.js
echo "ALL-GATES-DONE" >> $out
