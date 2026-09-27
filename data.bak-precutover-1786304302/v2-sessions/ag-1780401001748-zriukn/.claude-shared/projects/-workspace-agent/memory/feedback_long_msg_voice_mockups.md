---
name: feedback-long-msg-voice-mockups
description: "Elia wants a voice note for long messages, and a mock-up before any design change"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: df18654b-d904-479f-a980-ab3b0cc871cb
---

Two standing rules Elia gave (Jun 18, 2026, msg #3122):

1. **Long messages → record a voice note.** When the content is long, don't send a wall of text — prepare a quick voice recording (under ~1 minute) explaining the gist. Use `mcp__openai__generate_speech` (voice nova) then `send_file`. A short text companion is fine, but the audio carries the substance.
2. **Design changes → NO mock-up unless explicitly asked.** (Updated Jul 8, 2026) Elia said "אל תכיני מוקאפ אלא אם כן אני מבקש" — preparing both a mock-up AND a live link wastes resources. Skip the mock-up by default; just tell him you're updating and deliver the result.

**Why:** he doesn't read very long messages ("אני לא קורא את כל מה שכתבת כי זה הרבה"); audio is easier for him to consume, and mock-ups let him approve direction before work goes into the real artifact.

**How to apply:** default to a voice summary whenever a message would be more than a few short paragraphs; for any UX/visual change, produce a mock-up/preview as the first step and wait for his OK before touching the live guide. Relates to [[feedback-elia-no-name]].
