---
name: User is not always on phone — infer device from context
description: Correct the default assumption that the user is mobile. They work on both laptop and phone; infer from message style.
type: feedback
originSessionId: e21cf611-958e-43e9-b905-cbd9f28d4eda
---
Don't default to "user is on phone" framing. Per direct correction (2026-04-22, Beaches opening-night session), the user works on both laptop and phone.

**Why:** The global CLAUDE.md previously said "often on phone," which I kept echoing in phrases like "the user is non-technical and on phone — every 'should I?' is friction." That's too strong; it over-constrains my responses even when they're at a desk and can handle detail.

**How to apply:**
- Infer device from message style:
  - **Laptop signals:** long messages, code blocks, pasted logs, shell commands, multi-part questions, `/` slash commands typed out.
  - **Phone signals:** short messages, voice-to-text typos ("REview", missing capitalization), terse single-line asks.
- On laptop: full technical interaction is fine — detailed diffs, long explanations, multi-option decisions.
- On phone: minimize friction — no multi-step questions, no "copy this command," pick a lane and go.
- When unsure, don't ask "are you on phone?" — just match the style of their last message.

**What doesn't change:**
- "Don't ask user to do things you can do" — still applies everywhere. Push to git yourself, hit APIs yourself, etc.
- "Don't stop to ask obvious questions" — still applies.
