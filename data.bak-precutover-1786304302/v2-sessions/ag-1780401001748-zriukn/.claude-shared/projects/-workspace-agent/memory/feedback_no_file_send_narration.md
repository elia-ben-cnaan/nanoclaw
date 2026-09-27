---
name: feedback_no_file_send_narration
description: "When sending a voice note / file, don't also write \"I sent you a recording\" — the attachment speaks for itself"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4f46d027-34a4-48b0-a5aa-0e895cc0d452
---

When I deliver a voice note or file, do NOT add a separate text message announcing it ("שלחתי לך הקלטה" / "sent you a recording") — it's redundant (#6364, Jun 26).

**Why:** The attachment is self-evident; the extra line is noise and wastes a message/resources.

**How to apply:** Send the file with at most a one-line caption if truly needed. Never follow it with a second message restating the content. Combine with [[feedback_no_duplicate_delivery]] and [[feedback_resource_conservation]].
