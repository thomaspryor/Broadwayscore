# Experiments: mandatory setup contract

Every PostHog-flag-gated experiment MUST go through these five steps, in
this order, before it is considered "live." This contract exists because of
a real incident: on 2026-07-12 a session shipped the mobile-gate-timing
client code, a weekly monitor, and guardrail emails — but skipped step (a).
The PostHog flag was never created. The client polled a nonexistent flag
2,710 times across 2,708 people over 8 days, every response null, and
nothing detected the mismatch until a manual audit on 2026-07-20 (card #250).

**A test is live when strangers are being assigned, not when the code review
passes.**

## Steps

### (a) Create the flag via the API FIRST

Before writing a single line of client code. Do not create it through the
PostHog UI and do not defer it to "a follow-up card" — that deferral is
exactly what caused the 2026-07-12 incident.

```bash
curl -s -X POST "https://us.posthog.com/api/projects/332742/feature_flags/" \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "your-experiment-key",
    "name": "One-line description of the experiment",
    "active": true,
    "filters": {
      "groups": [{ "properties": [], "rollout_percentage": 100 }],
      "multivariate": {
        "variants": [
          { "key": "control", "name": "Control", "rollout_percentage": 50 },
          { "key": "treatment", "name": "Treatment", "rollout_percentage": 50 }
        ]
      }
    }
  }'
```

Verify it exists before moving on:

```bash
curl -s "https://us.posthog.com/api/projects/332742/feature_flags/?search=your-experiment-key" \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY" | node -e '
let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
  const r=JSON.parse(d).results||[];
  console.log(r.length ? "EXISTS: "+JSON.stringify(r[0].filters) : "DOES NOT EXIST — stop here");
})'
```

### (b) Register it in `scripts/lib/flag-registry.js`

Add an entry to `REGISTERED_FLAGS` with the flag's expected state (`exists`,
`active`, `variants`, `rollout`). This is what makes the flag-parity
guardrail able to detect drift for this experiment. See the existing entries
for the shape.

### (c) Wire the client + write a pre-registration doc

Client code calls `getFeatureFlag('your-experiment-key')` (or an exported
`const YOUR_FLAG = 'your-experiment-key'` constant — the registry's static
scanner in `scripts/lib/flag-registry.js` resolves both forms). Write a
pre-registration doc in `docs/experiments/your-experiment-key.md` following
the shape of [`gate-cold-start.md`](./gate-cold-start.md): what's being
measured, the primary metric, guardrails, and the minimum runtime before
judging results. Decide these BEFORE looking at any data.

### (d) Deploy

Normal deploy flow (CLAUDE.md §2).

### (e) Verify real assignments before claiming the experiment is live

Query PostHog for `$feature_flag_called` events for your flag key and
confirm you're seeing non-null arm assignments from real traffic:

```bash
node -e '
const r = await fetch("https://us.posthog.com/api/projects/332742/query/", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.POSTHOG_PERSONAL_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: { kind: "HogQLQuery", query: `
    SELECT JSONExtractString(properties,"\$feature_flag_response") AS arm, count()
    FROM events WHERE event = "\$feature_flag_called"
      AND JSONExtractString(properties,"\$feature_flag") = "your-experiment-key"
      AND timestamp > now() - INTERVAL 1 DAY
    GROUP BY arm` } }),
});
console.log(await r.json());
' # run with `node --experimental-fetch` or Node 18+
```

If every row is `arm = null` (or there are zero rows), the flag is not
resolving for real users — do not claim the experiment is live. Go back to
(a).

Only after (e) passes should the experiment be reported as live, and only
then does the weekly `scripts/monitor-flag-parity.js` guardrail (card #250)
start providing ongoing coverage — it checks the registry against live
PostHog state every Monday and alerts if a registered flag goes missing,
inactive, or drifts from its expected variant split.

## Why this exists

`scripts/lib/flag-registry.js` is enforced two ways:
- **Pre-merge**: `scripts/lib/flag-registry.test.mjs` fails CI if `src/`
  references a flag key with no registry entry.
- **Post-merge, weekly**: `.github/workflows/check-flag-parity.yml` compares
  every registered flag's live PostHog state against its expected state and
  emails an actionable alert on drift.

Neither of those can catch step (a) being skipped entirely for a NEW
experiment before its first commit — that step is still a human discipline
requirement, which is why it's spelled out here as step one, not step three.
