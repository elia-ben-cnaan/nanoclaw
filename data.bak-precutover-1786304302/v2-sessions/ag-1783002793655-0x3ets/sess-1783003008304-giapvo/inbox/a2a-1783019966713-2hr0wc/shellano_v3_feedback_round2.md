# Shellano v3 — Elia feedback round 2 (Jul 2, from #15306 onward)
He did NOT love v3. Sending a series of notes, said "wait for the end" before acting.

## Topbar / logo (#15364)
- nova CHANGED the logo and ADDED a mascot icon next to the "NanoShellano" wordmark. Elia does NOT want that.
- Wants ONLY our Nano logo in the corner (the corner = our Nano). Remove the redundant extra icon — wordmark + mascot icon = duplication.
- Our Nano does NOT need to be so big — must be IN PROPORTION. This is a fundamental note across the whole thing.
- LEFT side = language toggle to English. He wants EVERYTHING translated to English too, HE + EN like before (guide had it). Do not remove/change that behavior.
  → Topbar = logo (proportional Nano) on one side, עב/EN language toggle on the other, per the standing topbar rule (HE: logo right, toggle left; EN mirrors).
  → MAJOR: v3 mockup is currently Hebrew-only. Needs full English translation + working toggle + LTR mirror.

## Gender language (#15368)
- All texts must address BOTH male and female (לשון זכר ונקבה), with terminology that doesn't confuse/assume.
- Flagged example: CTA "בוא, הסוכן שלך מחכה" — "בוא" is masculine imperative. Need a formulation that works for both genders.
- Apply throughout every screen, HE (and mirror the inclusivity idea in EN too).

## Mascot missing antennae (#15370)
- Elia's real icon HAS antennae/feelers (מחושים) sticking up from the head. The mockup's mascot lost them.
- ROOT CAUSE confirmed: nova REDREW the logo as inline SVG → drifted from the real asset (lost antennae, wrong proportion, that's the "changed the logo" from #15364).
- FIX: I HAVE the correct logo → /workspace/agent/nanoshellano/nanoshellano-site/public/images/mascot.png (verified: teal Nano-with-glasses, waving claw/wrench, TWO antennae). Embed the REAL mascot.png (base64) in the mockup, do NOT hand-draw an SVG approximation.
- (Also have: lockup.png, lockup-shellano.png, wordmark.png, wordmark-dark.png, joni_face.png in same folder.)

## KILL the interactive demo — revert to the earlier simulation (#15374)
- Elia does NOT like the interactive inline-keyboard demo (buttons: "תעדכן לקוח...", "תכין מצגת...", "תקלוט אותי...", "תנתח נתונים"). Thinks it's WRONG.
- Why wrong: (1) implies THIS button-bot is what they actually get — it's not; (2) it's a fiction, which is exactly what we DON'T want; (3) we don't want interaction now — right now we want to move to INSTALLATION, not ask them to "play with the bot" (מיותר לגמרי); (4) buttons + messages are confusing — emotionally you expect real interaction but there's only a button next to the input = totally confusing.
- FIX: RETURN to the PREVIOUS state = the earlier auto-scripted linear simulation we did before (messages play on their own, NO interactive buttons/choices). This REVERSES nova's "interactive demo" idea (which Elia greenlit at #15290 but now rejects after seeing it live). Back to a clean watch-it-happen demo.
- Name the agent in the demo **ג'וני (Joni)**, not "הסוכן שלך".
- Place **his face** (= joni_face.png, the teal mascot-face crop with glasses) neatly and CENTERED as the avatar (מסודר, באמצע). [clarify with nova where "center" applies — likely the chat header avatar, done tidily.]

## Security screen — animate the reveal (#15376) [transcription garbled, best interpretation]
- Screenshot attached = SECURITY screen (מאובטח, ורק שלך, 5 pillars).
- "זה מעולה, אבל הייתי עושה את זה אינטראקטיבי" — he LIKES it but would make it feel alive: the highlighted points/text come in one by one IN ORDER, at a suitable pace, giving a feeling it's happening live, turning it from static/boring into "interactive" (= animated auto-reveal, NOT clickable buttons).
- So: stagger/animate the 5 security pillars to reveal in sequence (each appears in turn at a pleasant cadence) instead of all at once. Consistent with his taste = AUTO-play/watch-it-happen good, USER-clicking buttons bad (#15374).
- NOTE: transcription was poor — CONFIRM this reading with Elia before nova builds it, or have nova apply a gentle staggered reveal and show it.

## Too white and cold — bring in the brand colors (#15378) [transcription garbled]
- Screenshot = INSTALL screen (איך זה הולך להיות, 4-step timeline).
- "צריך לשחק קצת עם הצבעים, זה מרגיש יותר מדי לבן וקר. צריך לעשות שילוב צבעים נכון של המיתוג, אפשר לשחק עם זה."
- Meaning: the design feels TOO WHITE AND COLD (lots of white text on black). Introduce the BRAND palette for warmth, a proper branding color mix (teal #56EDD6, action teal #0F756D, highlight orange #E85D3A). Play with color, not monochrome white-on-black. General note across screens, esp. this one.

## Name field = FIRST + LAST, two fields (#15380)
- Screenshot = signup form. "כאן אמרנו שם ושם משפחה" = we said FIRST name AND LAST name here.
- CORRECTION: the form must have TWO name fields — שם (first) + שם משפחה (last), as originally agreed / as on the live site. REVERSES the earlier single "שם מלא" field. (My prior "Elia wants ONE" reading was wrong.)
- Observation (not his words): the screenshot shows ALL fields red with error text on an EMPTY form — validation is firing too early/aggressively, adds to the cold feel. Have nova make validation show only after the user interacts/submits, not by default.

## Expectations-bridge block isn't landing — rethink the concept (#15382)
- Screenshot = the "מה מקבלים עכשיו" bridge block (3 checks + "כל מה שראיתם בדמו הוא לאן זה הולך. הטעימה מתחילה היום.").
- "לא מתחבר לזה, לא מרגיש שזה הגשר, צריך לחשוב על הרעיון" = doesn't resonate, doesn't FEEL like the bridge, need to rethink the idea.
- This is nova's expectations-bridge (greenlit #15288-15290, now rejected after seeing it). The CONCEPT of bridging dream-demo → connection-less pilot is still valid, but this execution doesn't achieve it. nova needs a fresh idea for the bridge (or a different placement/framing). Ask nova to rethink.

## Headings: CENTER them + remove trailing period (#15384)
- Screenshot = the "פותחים לך משתמש." title.
- "הכותרות צריכות להיות ממורכזות, למרכז אותן, נראה יותר יפה שהן באמצע" = center the screen headings (looks nicer centered, not right-aligned).
- "לא צריך את סימני הפיסוק, לא צריך נקודה, זו כותרת של עמוד" = REMOVE the trailing period/punctuation from headings — a page title doesn't need it.
- Apply to ALL screen titles: "מאובטח, ורק שלך.", "איך זה הולך להיות.", "פותחים לך משתמש.", "הסוכן שלך מחכה בטלגרם." → drop the final period, center-align.

## Reinforce: no period + give it life (#15386)
- Screenshot = "מאובטח, ורק שלך." headline. "גם כאן אין צורך בפיסוק/נקודה" = reconfirms remove the period (all headings).
- "צריך לחשוב איך נותנים קצת חיים" = think how to give the headline/screen a bit more LIFE (energy/movement), it feels flat. Ties to the "too white and cold" (#15378) + "animate the reveal" (#15376) direction.

## Download buttons in brand color (#15388)
- Screenshot = install-screen download buttons (להורדה לנייד / להורדה למחשב), currently dark/neutral outlined.
- "הייתי שם לינק בצבע של המיתוג, כמו שהיה קודם" = make the buttons/links in the BRAND color (teal), like before. Not the current gray/dark style. Concrete instance of the "bring in brand colors" note (#15378).

## CTA button color is off-brand — revert to original (#15390)
- Screenshot = bottom CTA "יאללה, מתחילים לעבוד", currently dark teal-green (#0F756D).
- "הצבע הזה לא במיתוג, צריך לחזור לצבע המקורי" = this color is NOT on-brand, return to the ORIGINAL color.
- Have nova match the ORIGINAL live shellano.com / nanoshellano button color (don't invent). The current #0F756D green isn't it. Check landing.json / the original site tokens for the real primary button color.

## DONE giving notes (#15392)
- "זהו. בוא נחשוב איך פותרים את הגשר, וכל השאר לבצע את התיקונים." = that's all the notes.
- (1) The BRIDGE = open design question, think together / lock concept before building. (2) Everything else = execute now.

---
# ROOT THEME (for nova)
Most notes = "return to the ORIGINAL / previous state." nova REINVENTED (redrew logo as SVG, built interactive button demo, new colors) instead of staying faithful to the original live shellano.com. This round = a CORRECTION pass back toward the original brand + site, NOT a reinvention. Use the REAL assets, match ORIGINAL colors, revert the demo to the earlier auto-simulation. KEEP the genuinely-good new work: the Telegram-faithful chat rendering, the finish-screen text + name personalization + rescue path, back-arrow-top, no top register, single-CTA finish.

ORIGINAL BRAND ACCENT (verified from nanoshellano tailwind.config.ts + globals.css) = **#56EDD6 bright teal** (`--accent`). The mockup's CTA uses #0F756D dark green = wrong. Primary buttons/CTAs → revert to #56EDD6-based. Assets folder: /workspace/agent/nanoshellano/nanoshellano-site/public/images/ (mascot.png WITH antennae, joni_face.png, lockup.png, lockup-shellano.png, wordmark.png, wordmark-dark.png).
