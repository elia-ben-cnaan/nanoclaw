---
name: async-delivery
description: "For long async tasks (video/image generation), always tell the user upfront it'll take time, then deliver the result immediately when ready without waiting to be asked."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9454193d-adc3-479c-9731-876448ae5c91
---

When starting a long-running task (video generation, image rendering, file processing):
1. **Upfront:** Tell the user it'll take a few minutes ("זה ייקח לי כמה דקות")
2. **On completion:** Send the result immediately — do not wait for the user to ask

This is the expected default behavior, not something the user should need to request.

**Why:** User had to remind me after 20+ minutes that the video was ready. They expected automatic delivery.

**How to apply:** Any time I kick off an async job (Replicate prediction, background build, etc.) — set a mental flag to send the result as soon as it comes in, unprompted.
