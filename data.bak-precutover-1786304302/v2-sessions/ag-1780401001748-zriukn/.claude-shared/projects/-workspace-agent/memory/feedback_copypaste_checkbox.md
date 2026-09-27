---
name: feedback_copypaste_checkbox
description: "When giving Elia text to copy-paste elsewhere, mark it clearly (checkbox/separated block), never buried in prose"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3d7cc8ad-707a-4097-888a-206e8450336b
---

ANY text Elia should copy and paste somewhere — a prompt, a command, a message to relay — MUST be inside a fenced code block (triple-backtick ```), regardless of length. **This applies even to a single sentence or a whole paragraph, not just code/commands.** Never put copyable content as prose in chat. Re-emphasized forcefully and angrily by Elia on Jun 23, 2026 (#4572): "אל תכתבי לי יותר ככה בצ'אט. תשימי לי צ'קבוקס; זה מקום לטעויות... דברים שאת רוצה שאני אעתיק, גם אם זה משפט וגם אם זה פסקה, את שמה לי את זה בצ'קבוקס בלחיצה של העתק, הדבק, קל."

**Why:** Elia copy-pastes these verbatim; prose is "מקום לטעויות" (a place for errors) — he can't tell what to copy vs what is commentary, and formatting (e.g. Telegram italic eating underscores in PILOT_TELEGRAM_BOT_TOKEN) corrupts it. A code block both isolates the copyable text AND preserves literal characters.

**How to apply:** Fenced code block = the "checkbox" Elia means (Telegram renders it with a one-tap copy button). Keep my commentary OUTSIDE the block. Do NOT use ——— delimiters or plain prose for copyable content. Hard, permanent, non-negotiable default for every message. Relates to [[feedback_long_msg_voice_mockups]].
