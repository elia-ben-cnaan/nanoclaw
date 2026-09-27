---
name: feedback_claude_code_paste_text
description: "How to hand a task to Claude Code (host-Claude) — give pasteable inline TEXT, never files or terminal paths"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1d5b66f6-6a9f-448e-9140-142ea557f06d
---

When handing a build/dev task to Claude Code (host-Claude on the VM), deliver the prompt as **clean copy-paste TEXT inside the chat message** that Elia pastes straight into the Claude Code session.

Do NOT: send a `.md` workspace file expecting him to "pass it to Claude Code", or tell him to use the VM terminal to move files. He **cannot** drop my workspace files into the Claude Code/terminal session. I have repeated this mistake (file handoffs) multiple times — it frustrates him.

**Why:** the host-Claude session lives in a terminal/Claude-Code window with no path to my isolated container's filesystem. The only bridge is text he copies.

**How to apply:** when a Claude Code task is ready, paste the full prompt as text in the Telegram message. A file attachment is fine only as an extra, never as the delivery method.

**Better path he raised (Jun 25, #4978):** running host-Claude via the **Claude Code Desktop app** (Mac/Windows) is faster/stronger than a browser terminal — better file handling + persistent context. Prefer it when possible.

**Reconfirmed Jul 12, #25872-#25874:** even the Claude Code Desktop app would NOT accept a dragged `.md` file ("קלוד לא מקבל את הקובץ הזה"). The reliable delivery is ALWAYS the full prompt/script pasted as inline TEXT in the Telegram message. Default to inline text from the start — don't try the file route first.

Related: [[project_daniela_vm_terminal]]
