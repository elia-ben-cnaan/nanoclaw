---
name: project_pilot_reflection_jul16
description: Jul 16 2026 — all 6 Joni pilots self-assessed their user interactions; unanimous finding = they stay reactive/generic and fail to pivot users into concrete work
metadata: 
  node_type: memory
  type: project
  originSessionId: 83688248-a490-4718-bb54-db3275a6f49a
---

Jul 16 2026: Elia asked all 6 pilot agents for reports + self-reflection on how they handled their users. **All 6 responded; conclusion was unanimous.**

Users: 79e277=אודד ש. (פופו שבבי) · 1384f1=טל מסר (רופא חניכיים+אסתטיקה) · 3f22e4=leroy_brown (Notion+Slack) · a1b78a=**יחזקאל רבינוביץ** (the non-responder Elia flagged "מאתמול") · bfd53f=אלעד יאקובי (fundraiser) · dc8669=Ido Navarro (only asked infra questions).

**Unanimous self-diagnosis:** every pilot stayed *reactive* — answered questions, kept boundaries, was polite — but never pivoted the user into a real task. Conversations died at the intro stage; all users went silent.

**Two persona fixes they all converged on (ready to bake into pilot persona/script):**
1. **Pivot early** — after 2-3 exchanges, directly invite: "נראה שאתה בונה משהו / יש לך אתגר — בוא נעבוד על זה יחד עכשיו", don't wait for the user to lead.
2. **Avoid AI-ish format** — no numbered lists / bold / marketing copy (bfd53f: "נשמע כמו marketing copy, הרתיע אותו"). Second person, one question, one concrete example.

**Persona prompt handed to Elia to embed (Jul 17 #31722):** ready-to-paste Hebrew block encoding 5 rules — (1) human tone, no lists/bold/marketing copy; (2) pivot to real work after 2-3 exchanges; (3) auto gender detection, never address Anna as "אתה"; (4) identity = "אליה פיתח אותי" only; (5) short warm greeting, capabilities only when asked and in flowing prose not a list. Also gave an alternative short opening greeting to replace the current AI-ish capabilities wall. Trigger: live greeting on new pilot 9d7e89 (user Anna) showed the exact AI-ish list + a gender bug (addressed Anna as "אתה"). Elia is embedding it into the live pilot template himself.

**Follow-ups Elia greenlit (#30786):** (a) draft a persona/script update encoding the two fixes — ties into the owed Joni template update; (b) "מבחן יחזקאל" — simulate a re-engagement message from Yechezkel to pilot a1b78a and observe how it handles it. **Why:** Elia is stress-testing the pilots' conversational quality before scaling. **How to apply:** feed the two fixes into the live pilot template when Claude Code/VM access is available. Links [[reference_nanoclaw_pr3012_memory]] (memory system context).
