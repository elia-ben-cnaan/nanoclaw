---
name: think-before-acting
description: "Before guiding the user to any action, fully think through and verify the approach first — no mid-course corrections"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9454193d-adc3-479c-9731-876448ae5c91
---

Before leading the user to any action (create something, configure something, run something):
1. Think through the complete path end-to-end
2. Verify there are no known blockers or wrong turns
3. Only then give precise, final instructions

**Why:** User was led to create a "TVs and Limited Input devices" OAuth client that turned out to not support Gmail at all — wasted effort and caused confusion. They explicitly asked for this behavior change.

**How to apply:** Any time I want to say "go do X" — pause and ask: does X definitely work for our use case? Have I checked for gotchas? Is this the final answer or might I need to change direction? Only proceed when confident.
