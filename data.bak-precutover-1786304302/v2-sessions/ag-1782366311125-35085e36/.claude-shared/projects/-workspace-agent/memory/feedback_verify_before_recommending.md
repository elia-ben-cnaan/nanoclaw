---
name: verify-before-recommending
description: "Always test and verify a tool/integration works before recommending it to the user — don't lead into a process that fails midway"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9454193d-adc3-479c-9731-876448ae5c91
---

Before recommending any tool, connection, or process:
1. **Test it first** — try connecting, check if it's blocked, verify it actually works
2. Only then recommend it with confidence
3. If there are known limitations (bot protection, API requirements, etc.), say so upfront — before starting

**Why:** User was led through a Canva browser automation process that failed at the end due to Cloudflare bot protection. They had to discover the limitation themselves instead of being told upfront.

**How to apply:** Any time I suggest "let's connect X" or "I can do Y via browser" — test the actual path first, or say explicitly "I haven't tested this yet, there may be bot protection." Never present a capability as confirmed until it's verified in our environment.
