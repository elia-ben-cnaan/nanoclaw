# master_prompt_v2.md · NanoCo Pilot · הנחיות עבודה ל-Claude Code על daniela VM

> נוצר על ידי nova, 6.7.2026. מסמך זה נועד להדבקה ישירה ל-Claude Code Desktop על ה-VM.
> עיקרון עבודה: כל שינוי עובר גייט אימות לפני שממשיכים לשלב הבא. אם גייט נכשל, עוצרים ומדווחים, לא ממשיכים.

## איך נבנה המסמך (שקיפות מקורות)

- אומת חי (6.7.2026, 13:45 UTC, בדיקות read-only מבחוץ): nanohubdemo.vercel.app (דף בית, nano.html, ops.html, api/register), provision.shellano.com (טאנל חי, /provision קיים), שני הבוטים בטלגרם, ops_data.json.
- מהקשר מתועד (CLAUDE.local.md של nova + תדריך דניאלה): ארכיטקטורת ה-VM, שמות קבצים, היסטוריית באגים, החלטות מוצר.
- לא אומת (אין ל-nova גישה לקבצי ה-VM): תוכן provision-handler.ts, telegram-pilot.ts, ה-.env, מצב systemd. לכל אלה יש שלב discovery לפני נגיעה.
- קבצי עזר שהוזכרו (pilot_agent_script_v2.md, joni_bot_claudecode_handoff.md) לא היו זמינים ל-nova. אם הם על ה-VM, קרא אותם לפני חלק ג.

## כללי ברזל (לא לשבור בשום שלב)

1. **אסור לגעת ב-ONECLI_BIND_HOST או בכל דבר בשרשרת OneCLI.** לא בקוד, לא ב-env, לא ב-firewall.
2. **מופע יחיד מנוהל-supervisor בלבד.** אין `nohup`, אין הרצה ידנית של השירות ברקע. double-launch שובר את הערוץ הנכנס של טלגרם.
3. אחרי **כל** restart של השירות, שני האימותים האלה חובה לפני שממשיכים:
   ```bash
   # (א) מאזין יחיד על :3000
   ss -tlnp | grep ':3000'   # חייבת לחזור שורה אחת בדיוק
   # (ב) הצינור הנכנס חי: שלח הודעת טסט לבוט מחשבון טלגרם ובדוק תגובה אחת בדיוק
   ```
4. אין מחיקת דאטה של סוכנים קיימים (תיקיות groups/, בסיסי נתונים) בלי גיבוי קודם.
5. לפני כל שינוי: `git status`, ואם יש שינויים לא-שמורים של מישהו אחר, לעצור ולדווח.

---

# חלק א · מה עובד, ואין לגעת

| רכיב | סטטוס | ראיה (6.7.2026) |
|---|---|---|
| אתר nanohubdemo.vercel.app + nano.html (6 מסכים, עברית RTL) | חי | GET מחזיר 200, התוכן המצופה |
| ops.html + ops_data.json (רענון שעתי דרך schedule_task) | חי ומתעדכן | updated=2026-07-06T13:00Z, נתוני fleet אמיתיים |
| api/register | חי, ולידציה עובדת | GET מחזיר `{"ok":false,"error":"method"}`, POST ריק מחזיר `{"ok":false,"error":"name"}` |
| Cloudflare Named Tunnel אל provision.shellano.com | חי כרגע | GET /provision מחזיר 405 מה-origin (הטאנל מעביר), / מחזיר 404 |
| endpoint /provision על ה-VM | קיים ומאזין | 405 על GET מעיד שהראוט קיים ומצפה ל-POST |
| @joni_agent_bot (userId 8849389246) | רשום בטלגרם, שם "joni", יש תמונת פרופיל בעמוד הציבורי | t.me/joni_agent_bot מחזיר 200 עם photo block |
| @Nanoco_pilot_bot (userId 8647391266) | רשום, שם "Nanoco pilot", בלי תמונת פרופיל | t.me/Nanoco_pilot_bot מחזיר 200 בלי photo block |
| שרשרת E2E provision (register → deepLink) | אושרה בסימולציה | דיווח דניאלה |
| סוכן הפיילוט הנוכחי ג'וני (pilot-b7904e) | קיים, על claude-haiku-4-5, לא רץ כרגע | ops_data.json |

**לא לגעת:** nano.html בפרודקשן (עדכון קופי EN הוא משימה נפרדת שכבר נמסרה), ops pipeline, קונפיגורציית הטאנל עצמה, וכל שרשרת OneCLI.

---

# חלק ב · באגים ידועים + תיקון מפורש

## ב-1. triple-message: לוודא שנפתר בקוד, לא רק שלא שוחזר

**הבעיה:** כל הודעה נכנסת קיבלה 3 תשובות. בסימולציה האחרונה נצפתה תגובה אחת, אבל לא אומת שהתיקון קיים ברמת הקוד. יש להוכיח, ואם אין תיקון, לממש dedup.

**קבצים:** `telegram-pilot.ts`, `provision-handler.ts`, וכל מודול outbound/queue בריפו nanoclaw-v2.

**שלב 1, אבחון (לפני כל שינוי):**
```bash
cd <repo-root>   # nanoclaw-v2
grep -rn "sendMessage\|sendText\|bot.api.send" src/ --include='*.ts' | grep -v test
# לחפש: כמה consumers רשומים על אותו תור/אירוע? האם יש 3 רישומים של handler
# (למשל on('message') שנקרא פעם אחת לכל אינסטנס אבל נרשמים 3 אינסטנסים)?
grep -rn "on('message'\|addListener\|subscribe\|createBot\|new Bot(" src/ --include='*.ts'
```
שורש נפוץ: הרישום של ה-handler רץ יותר מפעם אחת (init כפול, hot-reload, או שלושה workers על אותו polling). לתעד את הממצא לפני תיקון.

**שלב 2, תיקון idempotent-outbound (גם אם השורש תוקן, זו רשת ביטחון):**
- טבלת SQLite חדשה (על ה-DB הקיים בסטאק):
  ```sql
  CREATE TABLE IF NOT EXISTS outbound_sent (
    dedup_key TEXT PRIMARY KEY,   -- `${inboundMessageId}:${chatId}:${seq}`
    sent_at INTEGER NOT NULL
  );
  ```
- לפני כל שליחה: `INSERT` עם המפתח. אם נכשל על PRIMARY KEY, מדלגים על השליחה ומתעדים ב-log ברמת warn (זה סימן שהשורש עדיין חי).
- ניקוי: מחיקת רשומות בנות יותר מ-7 ימים בהפעלה.
- אין להוסיף ספריית idempotency חיצונית. unique constraint על SQLite הקיים מספיק ופשוט.

**גייט אימות ב-1:**
```bash
# 1. בדיקת יחידה: קריאה כפולה ל-sendOutbound עם אותו dedup_key שולחת פעם אחת
# 2. restart דרך supervisor בלבד, ואז:
ss -tlnp | grep ':3000'        # שורה אחת
# 3. שליחת 3 הודעות טסט לבוט מחשבון אמיתי. כל אחת מקבלת תגובה אחת בדיוק.
# 4. grep בלוג: אין שורות warn של dedup-skip בזרימה תקינה.
```

## ב-2. עמידות הטאנל ל-reboot (לא ידוע אם מוגדר)

**הבעיה:** לא אומת ש-cloudflared רץ כ-systemd service עם enable. אם ה-VM יאותחל, provision.shellano.com ימות בשקט.

```bash
systemctl status cloudflared --no-pager
systemctl is-enabled cloudflared
# אם לא enabled:
sudo systemctl enable cloudflared
# אותו דבר לשירות ה-provision עצמו: לזהות את שם ה-unit (systemctl list-units | grep -iE 'provision|nanoclaw') ולוודא enabled
```

**גייט אימות ב-2:** `systemctl is-enabled` מחזיר enabled לשני השירותים, ו-`curl -s -o /dev/null -w '%{http_code}' https://provision.shellano.com/provision` מחזיר 405 (מבחוץ). אם אפשר לתאם חלון, reboot מבוקר אחד הוא ההוכחה האמיתית; אם לא, להסתפק ב-is-enabled + תיעוד.

## ב-3. אבטחת /provision: אימות טוקן + rate limiting (לא מאומת שקיים)

**הבעיה:** לא ידוע אם ה-endpoint דורש token ואם יש הגבלת קצב. הוא חשוף לאינטרנט דרך הטאנל.

**שלב 1, אבחון:**
```bash
grep -rn "PROVISION_TOKEN\|authorization\|bearer" src/ --include='*.ts' -i
# מבחוץ (או מה-VM עצמו אל localhost:3000):
curl -s -X POST -H 'content-type: application/json' -d '{}' http://localhost:3000/provision
# אם התשובה היא שגיאת ולידציה ולא 401, אין אימות. זה חור פתוח.
```

**שלב 2, תיקון (אם חסר):**
- דרישת header ‏`Authorization: Bearer ${HOST_PROVISION_TOKEN}` על כל POST /provision, השוואה ב-constant-time (`crypto.timingSafeEqual`), 401 על כשל.
- rate limit פשוט בזיכרון: מפתח לפי IP (header ‏`CF-Connecting-IP` שמגיע מ-Cloudflare), חלון 10 בקשות לדקה, 429 מעבר לזה. בלי ספרייה חדשה אם יש משהו בסטאק; אחרת מותר `Map` ידני של 30 שורות.
- לוודא שהטוקן ב-`.env` על ה-VM זהה ל-`HOST_PROVISION_TOKEN` ב-Vercel (ראה גייט).

**גייט אימות ב-3:**
```bash
# בלי טוקן → 401:
curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' http://localhost:3000/provision   # 401
# עם טוקן שגוי → 401. עם הטוקן מה-.env → 400 ולידציה (לא 401):
TOKEN=$(grep HOST_PROVISION_TOKEN .env | cut -d= -f2)
curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -d '{}' http://localhost:3000/provision   # 400
# התאמת Vercel: להריץ `vercel env pull` בפרויקט nanohubdemo (או לבדוק בדשבורד) ולהשוות את הערך ואת HOST_PROVISION_URL=https://provision.shellano.com/provision
# E2E: הרשמת טסט אחת דרך האתר עוברת, כלומר Vercel באמת שולח את הטוקן הנכון.
# rate limit: לולאת 15 בקשות ריקות → החל מבקשה 11 חוזר 429.
```

## ב-4. חשיפת מידע ב-ops_data.json (ממצא חדש מהסקירה)

**הבעיה (אומת חי):** `https://nanohubdemo.vercel.app/ops_data.json` ציבורי לגמרי וחושף מזהי סוכנים פנימיים, שמות תיקיות (כולל pilot-b7904e), מודלים וזמני פעילות של כל ה-fleet, כולל הסוכנים הפנימיים (Daniela, nova, builder).

**תיקון מוצע (לבחירת אליה, ברירת מחדל = אפשרות 1):**
1. מינימלי: להוציא מה-JSON את הצוות הפנימי ואת שדות id/folder, להשאיר רק שם+סטטוס של סוכני פיילוט.
2. חזק יותר: להעביר את ops.html + ops_data.json לנתיב עם basic auth או token בכתובת שאינה ניתנת לניחוש.

**גייט אימות ב-4:** curl ל-ops_data.json לא מחזיר יותר מזהים פנימיים/שמות תיקיות; ops.html עדיין מציג את מה שאליה צריך.

## ב-5. תשובה לשאלות הפתוחות של דניאלה (לתעד בדוח הסיום של Claude Code)

- **מה קורה לג'וני (pilot-b7904e) כשנגמרות ה-turns:** לאתר בקוד את מנגנון המגבלה (`grep -rn "turn\|limit\|quota" src/ --include='*.ts' -i`) ולתעד: מה ההתנהגות בפועל (שקט? הודעה? קריסה?). אם ההתנהגות היא שתיקה, להוסיף הודעת "נגמרה המכסה להיום" למשתמש. זו חוויית פיילוט קריטית.
- **session leak:** ‏`ncl sessions list` (או המקבילה על ה-VM) + ‏`ls groups/` מול רשימת הסוכנים החיה. לספור: כמה תיקיות/סשנים יש מול כמה סוכנים אמורים להתקיים. נכון ל-6.7 ה-fleet הציבורי מציג 4 סוכני fleet + 3 team, ואין סימן לדליפה, אבל רק בדיקה על ה-VM עצמו תסגור את זה.

---

# חלק ג · פיתוח חדש שטרם בוצע

> סדר מומלץ: ג-1 (תבנית v2) → ג-2 (אקטיבציה) → ג-3 (ניתוב שני בוטים) → ג-4 (משימות ידניות/ניקיון).
> ההנחיה של אליה: לא לבנות מאפס רכיבים שיש להם פתרון מוכן, אבל בהיקפים כאן (טוקנים חד-פעמיים, dedup) הפתרון הנכון הוא crypto/nanoid + SQLite שכבר בסטאק, לא ספריות חדשות.

## ג-1. עדכון hosted_agent_template לסקריפט v2

**הבעיה:** ג'וני עשה overclaiming חמור בסימולציה (טען שיש לו Git, קבצים, תמונות, דשבורדים, real-time, יצירת סוכנים). הסקריפט המתוקן קיים כ-`pilot_agent_script_v2.md` אבל התבנית על ה-VM עדיין עם v1.

**שלבים:**
```bash
# לאתר את התבנית:
find / -maxdepth 6 -iname "*hosted_agent_template*" -o -iname "*agent_template*" 2>/dev/null | grep -v proc
# לאתר את הסקריפט החדש (אמור להיות על ה-VM או אצל דניאלה):
find /home /root /workspace -iname "pilot_agent_script_v2.md" 2>/dev/null
```
- להחליף את תוכן ה-CLAUDE.md/סקריפט בתבנית בגרסת v2, מילה במילה, בלי עריכה יצירתית.
- **חשוב:** העדכון חל על סוכנים חדשים. להחליט (ולתעד) אם מעדכנים גם את pilot-b7904e הקיים, ואם כן, לעדכן את קובץ ההנחיות שלו באותו אופן.

**גייט אימות ג-1:** ‏diff בין התבנית לבין pilot_agent_script_v2.md ריק; provision של סוכן טסט חדש ובדיקה בצ'אט: לשאול אותו "אתה יכול לערוך לי תמונה?" והוא עונה בהתאם לגבולות v2 (בלי overclaiming). למחוק את סוכן הטסט בסוף ולוודא שנמחק.

## ג-2. אקטיבציה דרך טלגרם ב-provision handler (הספק המלא שאושר)

**דרישות (נעולות על ידי אליה):**
1. קוד חד-פעמי לכל deep link. נשרף אחרי שימוש. תוקף 24 שעות.
2. הסוכן נקשר לזהות הטלגרם של מי שלחץ START, לא למספר הטלפון.
3. סוכן פעיל אחד לכל משתמש טלגרם. START נוסף מנתב לסוכן הקיים, בלי כפילות.
4. טלפון/מייל מהטופס = מטא-דאטה בלבד.
5. שם ברירת מחדל קבוע: ג'ני.
6. שפת הודעת הפתיחה לפי שדה `lang` (he|en) מהטופס.
7. חלון פיילוט: 10 ימים מרגע ההפעלה (לחיצת START), לא מרגע ההרשמה.

**מימוש מוצע:**
- טבלאות:
  ```sql
  CREATE TABLE IF NOT EXISTS activation_codes (
    code_hash TEXT PRIMARY KEY,          -- sha256 של הטוקן, לא הטוקן עצמו
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,         -- created_at + 24h
    used_at INTEGER,
    telegram_user_id TEXT,               -- מתמלא בשריפה
    meta_name TEXT, meta_phone TEXT, meta_email TEXT, lang TEXT DEFAULT 'he'
  );
  CREATE TABLE IF NOT EXISTS active_agents (
    telegram_user_id TEXT PRIMARY KEY,
    agent_group_id TEXT NOT NULL,
    activated_at INTEGER NOT NULL,
    pilot_ends_at INTEGER NOT NULL       -- activated_at + 10 ימים
  );
  ```
- יצירת קוד: `crypto.randomBytes(16)` → base64url → deep link ‏`https://t.me/<bot>?start=<token>`. שומרים hash בלבד.
- ב-handler של `/start <token>`: לחשב hash, לשלוף בעדכון אטומי יחיד (`UPDATE ... SET used_at=?, telegram_user_id=? WHERE code_hash=? AND used_at IS NULL AND expires_at > ?`); אם 0 שורות עודכנו → הודעת "הקישור כבר נוצל או פג" עם הפניה להרשמה מחדש.
- לפני יצירת סוכן: בדיקת `active_agents` לפי telegram_user_id. אם קיים ופעיל → הודעת "הסוכן שלך כבר כאן" וניתוב אליו, בלי provision חדש.
- הודעת פתיחה לפי `lang`, הסוכן מציג את עצמו כ"ג'ני".
- פקיעת פיילוט: בכניסת הודעה, אם `now > pilot_ends_at`, תגובה מנומסת שהפיילוט הסתיים (טקסט מאושר יתקבל מאליה; עד אז placeholder ניטרלי מתועד).

**גייט אימות ג-2 (סוכני טסט בלבד, למחוק בסוף):**
1. register → link → START ראשון: סוכן קם, פתיחה בשפה הנכונה, שם ג'ני.
2. אותו link פעם שנייה (או מחשבון אחר): נדחה, לא קם סוכן שני.
3. register שני מאותו משתמש טלגרם → START: מנתב לסוכן הקיים, `active_agents` נשאר עם שורה אחת.
4. קוד עם expires_at בעבר (לזייף ב-DB לצורך בדיקה): נדחה.
5. `pilot_ends_at` בעבר (לזייף ב-DB): הודעת סיום פיילוט.
6. `ss -tlnp | grep :3000` שורה אחת + הודעת inbound רגילה מקבלת תגובה אחת.

## ג-3. שני בוטים, ניתוב נפרד

**היעד:** ‏@joni_agent_bot (8849389246) משרת את סוכני הפיילוט; @Nanoco_pilot_bot (8647391266) לפי ההגדרה שאליה יקבע (כרגע לא בשימוש פעיל). הניתוב לא ממומש.

**שלבים:** לאתר איפה טוקן הבוט נטען (`grep -rn "BOT_TOKEN\|bot_token" src/ .env* -i`), להפוך לרשימת בוטים עם מיפוי bot→purpose, ולוודא ששני polling loops לא דורכים זה על זה (או ששניהם עוברים ל-webhook על :3000 בנתיבים נפרדים; לתעד את הבחירה). **זהירות כפולה מכלל הברזל 2: שני בוטים = פיתוי ל-double-launch. מופע תהליך אחד שמחזיק את שניהם.**

**גייט אימות ג-3:** הודעה ל-@joni_agent_bot מקבלת תגובה אחת; הודעה ל-@Nanoco_pilot_bot מקבלת את ההתנהגות שהוגדרה לו; `ss -tlnp | grep :3000` עדיין שורה אחת; בלוג אין שגיאות 409 Conflict של טלגרם (הסימן המובהק לשני polling על אותו בוט).

## ג-4. משימות קטנות / ידניות

1. **תמונת פרופיל לג'וני:** לעמוד t.me/joni_agent_bot כבר יש תמונה (אומת 6.7). לוודא מול אליה שזו התמונה שהוכנה; אם לא, ההעלאה היא ידנית מול BotFather (‏/setuserpic), לא ניתנת לביצוע מהקוד. ל-@Nanoco_pilot_bot אין תמונה.
2. **ניקוי פרויקטי Vercel ישנים** (shellano-deploy, nanoshellano-landing, nanoclaw_guide): לפני מחיקה, לוודא ששום דומיין/DNS לא מצביע אליהם (`vercel domains ls`, בדיקת aliases לכל פרויקט). מחיקה רק אחרי אישור אליה ברשימה מפורשת של מה נמחק. **גייט:** האתר הראשי והטאנל עובדים אחרי הניקוי.
3. **connection layer (Gmail/Calendar):** חסום על באג auth gateway של OneCLI, נמסר למנטיינר. לא לגעת ולא לעקוף. רק לוודא שאין קוד חצי-גמור שנטען בפרודקשן (feature flag כבוי או קוד מחוץ למסלול).

---

# חלק ד · בדיקות אימות מסכמות (verify gates, להריץ בסוף הכל)

```bash
# 1. תהליך יחיד ומאזין יחיד
ss -tlnp | grep ':3000'                          # שורה אחת בדיוק
systemctl status <provision-unit> --no-pager     # active (running), דרך supervisor
systemctl is-enabled cloudflared <provision-unit> # enabled, enabled

# 2. שרשרת מבחוץ פנימה
curl -s -o /dev/null -w '%{http_code}' https://provision.shellano.com/provision          # 405 (GET)
curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' https://provision.shellano.com/provision  # 401 (בלי טוקן)
curl -s https://nanohubdemo.vercel.app/api/register -X POST -H 'content-type: application/json' -d '{}'  # שגיאת ולידציה, לא 500

# 3. E2E מלא אחד (עם משתמש טסט, למחוק בסוף)
# טופס באתר → deep link → START → סוכן "ג'ני" עונה פעם אחת, בשפה הנכונה
# START חוזר על אותו לינק → נדחה

# 4. triple-message
# 3 הודעות שונות לבוט → 3 תגובות בדיוק (אחת לכל הודעה), אפס כפולים בלוג

# 5. אבטחה
# ops_data.json לא חושף מזהים פנימיים; אין טוקנים ב-git:
cd <repo-root> && git log -p | grep -icE 'aoc_|bot[0-9]+:[A-Za-z0-9_-]{30,}|sk-ant' || echo clean
grep -rn "sk-ant\|[0-9]{8,}:AA" src/ --include='*.ts' | grep -v env  # אפס hardcoded tokens

# 6. עמידות
# אם אפשר: reboot מבוקר → הטאנל והשירות חוזרים לבד → בדיקה 2 עוברת שוב
```

**דוח סיום נדרש מ-Claude Code:** לכל סעיף בחלקים ב-ג: בוצע/לא בוצע, פלט הגייט, וכל סטייה מהמסמך עם נימוק. בנוסף: התשובות לשתי השאלות הפתוחות (התנהגות סוף-turns של ג'וני, ספירת sessions מול סוכנים).
