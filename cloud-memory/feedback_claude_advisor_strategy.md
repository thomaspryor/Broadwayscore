---
name: Claude advisor strategy API pattern
description: How to wire Opus 4.7 as advisor with Sonnet/Haiku executor — beta header, tool shape, and response parsing gotchas
type: feedback
originSessionId: aa9a4dec-42bf-4e5c-a08c-a169a8158d1d
archived: true
---
When using the Claude advisor strategy (Opus 4.7 advisor + Sonnet/Haiku executor):

**API shape (beta as of 2026-04-17):**
```js
// Add to headers:
'anthropic-beta': 'advisor-tool-2026-03-01'

// Add to request body:
tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-7', max_uses: 1 }]
```

**ALWAYS use content.find() not content[0]:**
When the advisor fires, the response content array is `['server_tool_use', 'advisor_tool_result', 'text']`. `content[0]` is NOT the text block. Use:
```js
const text = response.content.find(c => c.type === 'text')?.text;
if (!text) throw new Error(`No text block. Types: ${response.content.map(c=>c.type).join(', ')}`);
```

**Why:** Confirmed live: advisor-invoked response returned `['server_tool_use','advisor_tool_result','text']` — `content[0].text` was `''`, `content.find()` returned the correct answer.

**Haiku as executor is risky:** Haiku may not self-direct to call the advisor. The advisor is passive — executor decides when to call it. Sonnet self-directs more reliably. If using Haiku + advisor and quality doesn't improve, add to system prompt: "consult your advisor when you are uncertain."

**max_uses: 1** is appropriate for binary classification (one advisory call per request). For batch classification (5 items in one request), consider whether `max_uses` should match batch size.

**Task budgets (separate feature):** NOT the same as advisor. Task budgets (`output_config.task_budget`) is advisory, per single request, for agentic loops. For bulk pipeline scripts making N separate calls, use a custom `--max-cost` flag instead.

**How to apply:** Any script adding the advisor tool needs content.find() — not content[0]. The 26 remaining scripts using content[0].text are safe only because they don't use the advisor yet.
