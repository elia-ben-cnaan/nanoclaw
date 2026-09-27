export const meta = {
  name: 'agent-workday-flows-v2',
  description: 'Second loop: proactive/recurring + advisor + triage + personal + comms-scaling flows, avoiding overlap with the first 19',
  phases: [
    { title: 'Generate' },
    { title: 'Select' },
    { title: 'Develop' },
    { title: 'Synthesize' },
  ],
}

const CONTEXT = `
מוצר: סוכן AI אישי (NanoClaw) לאדם עובד.
הרפריים המרכזי: הסוכן הוא לא תחליף ל-ChatGPT. הוא ה"פעולה הרוחבית" / המייל האחרון / שכבת הזיכרון סביב העבודה הקיימת. המשתמש ממשיך לעבוד רגיל, מייצר תוצרים בכלים שלו, ואז מוסר לסוכן והסוכן לוקח הלאה: מייל שנשלח, פגישה שזומנה, וואטסאפ מוכן, הכנה לפגישה, מסמך. הרבה מזה בלי חיבור לשום מערכת (קישורי compose של Gmail, קישורי תבנית של Google Calendar עם add=email, ICS, forward של תמלול). הסוכן זוכר את שגרת העבודה: מי מחכה, אילו פולואפים בשלים. מסלול שדרוג: כשמוכן מחברים כלים והזרימות הופכות אוטומטיות. הסוכן גם יכול לפעול על ציר זמן (משימות מתוזמנות) וליזום מולך.

הכאב: ChatGPT אפיזודי וחסר זיכרון, התוצר נשאר בצ'אט, יש "מייל אחרון" של העתק-הדבק-שלח שאוכל זמן, ואנשים פוחדים לחבר מערכות. הערך: זיכרון של העבודה + השלמת המייל האחרון + אפס חיכוך + יוזמה על ציר זמן.

הפוקוס בסבב הזה: שגרות פרואקטיביות וחוזרות, יועץ-לחשיבה, טריאז' של ערימות, חיים אישיים, וסקיילינג של תקשורת. זהו שדרוג מעבר לפלואוז ריאקטיביים.

כללי כתיבה מחייבים: עברית טבעית וזורמת, בלי מקפים ארוכים (em-dash), בלי שום סימן שנכתב ע"י AI, מסגור per-בן-אדם ולא per-תפקיד, מסגור חיובי.
`

const AVOID = `הימנע מחפיפה עם 19 הפלואוז שכבר פותחו בסבב הקודם (אל תחזור עליהם):
המייל האחרון אחרי הצ'אט, מתמלול פגישה לסיכום שנשלח ללקוח, מי מחכה לי לתשובה, פולואפ בשל שמזכיר את עצמו, הכנה לפגישה מהזיכרון, תיאום פגישה בלי משחק פינג פונג, תשובה קשה שצריך לרכך, הודעת וואטסאפ ללקוח מוכנה, בריף בוקר בשתי דקות, סגירת יום ורשימת מחר, זיכרון לקוחות לאורך זמן, מפת פולואפים לשבוע, מהקלטה קולית לתוצר, ממחקר לפוסט מוכן, טיוטת הצעת מחיר מהראש למייל, מתמלול ראיון למסמך ללקוח, טיוטת חשבונית לרואה חשבון, קואצ'ינג לעבודה טובה יותר עם ChatGPT, שדרוג לזרימה אוטומטית.`

const IDEA_SCHEMA = {
  type: 'object',
  properties: {
    flows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          moment: { type: 'string' },
          mechanic: { type: 'string' },
          connection: { type: 'string' },
        },
        required: ['name', 'moment', 'mechanic', 'connection'],
      },
    },
  },
  required: ['flows'],
}
const SELECT_SCHEMA = {
  type: 'object',
  properties: {
    selected: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          moment: { type: 'string' },
          mechanic: { type: 'string' },
          connection: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['name', 'moment', 'mechanic', 'connection'],
      },
    },
  },
  required: ['selected'],
}
const DEV_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    markdown: { type: 'string' },
  },
  required: ['name', 'markdown'],
}
const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    intro_markdown: { type: 'string' },
    effectiveness_markdown: { type: 'string' },
    meta_ideas_markdown: { type: 'string' },
  },
  required: ['intro_markdown', 'effectiveness_markdown', 'meta_ideas_markdown'],
}

phase('Generate')
const DOMAINS = [
  { key: 'שגרות חוזרות על ציר זמן', seed: 'דוח/עדכון שבועי קבוע ללקוח או מנהל שמוכן בזמן, 1:1 חוזר עם אג׳נדה מצטברת, קצב פרסום שהסוכן מציע את הפוסט הבא, תזכורות שהסוכן יוזם כשמשהו שקט מדי, סבב סטטוס שבועי, תחזוקת לקוחות רדומים' },
  { key: 'יועץ לחשיבה והחלטות', seed: 'שותף להתלבטות עם יתרונות וחסרונות לפי הקונטקסט שלך, שליפת החלטות ורציונל מהעבר, ליבון מחיר לפני שיחה, sounding board שזוכר את המצב שלך, סדר עדיפויות כשהכל דחוף' },
  { key: 'טריאז׳ של ערימות', seed: 'עיבוד אצווה של מיילים או הודעות למה דורש תשובה ומה יכול לחכות עם טיוטות לקצרים, דייג׳סט קריאה של לינקים ומאמרים שנשמרו, סינון וסידור של ערימת משימות פתוחות, ניקוי תיבת נכנס' },
  { key: 'חיים אישיים ואדמיניסטרציה', seed: 'תורים ולוגיסטיקה משפחתית וסידורים, קבלות והוצאות עם סיכום חודשי, ניהול תזכורות אישיות, רשימות קניות ומטלות בית, תכנון אירוע או טיול, מעקב אחרי התחייבויות אישיות' },
  { key: 'סקיילינג של תקשורת', seed: 'פנייה מותאמת אישית באצווה לכמה לידים כל אחד מותאם מהזיכרון, אונבורדינג לקוח חדש כרצף קבוע, תבנית הודעה חוזרת שמתאימה את עצמה, ברכות ונגיעות יחסים בקנה מידה, מעקב אחרי רשת קשרים' },
]
const rounds = (await parallel(DOMAINS.map((d) => () =>
  agent(
    `${CONTEXT}\n\n${AVOID}\n\nאתה מחולל רעיונות לפלואוז חדשים של ייעול שגרות. תחום מיקוד: "${d.key}" (${d.seed}).\n` +
    `תן 8 עד 10 פלואוז נבדלים וקונקרטיים שלא חופפים לרשימה הקודמת. כל פלואו = רגע אנושי אמיתי, המכניקה (מה נכנס ומה יוצא), ורמת החיבור. תהיה יצירתי ותגיע לכמה שיותר רעיונות איכותיים ומעשיים.`,
    { label: `gen:${d.key}`, phase: 'Generate', schema: IDEA_SCHEMA }
  )
))).filter(Boolean).flatMap(r => r.flows)
log(`נוצרו ${rounds.length} רעיונות גולמיים`)

phase('Select')
const pick = await agent(
  `${CONTEXT}\n\n${AVOID}\n\nלהלן ${rounds.length} רעיונות גולמיים:\n${JSON.stringify(rounds, null, 2)}\n\n` +
  `אחד כפילויות, מזג דומים, זרוק כל מה שחופף לרשימה הקודמת, ובחר את הסט הכי חזק ונבדל של 16 עד 20 פלואוז חדשים. ` +
  `קריטריון: ערך ייחודי (זיכרון + מייל אחרון + אפס חיכוך + יוזמה על ציר זמן), per-בן-אדם, מגוון, לא חופף לא לעצמו ולא ל-19 הקודמים. דרג מהחזק לפחות.`,
  { label: 'select', phase: 'Select', schema: SELECT_SCHEMA }
)
const selected = (pick?.selected || []).slice(0, 20)
log(`נבחרו ${selected.length} פלואוז לפיתוח`)

phase('Develop')
const FORMAT = `
פורמט חובה לכל מקטע (markdown, עברית):

### <שם הפלואו>
**הרגע:** <הרגע/הכאב האנושי, משפט או שניים>
**איך זה עובד:** רשימה ממוספרת של שלבי הזרימה (מה נכנס, מה הסוכן עושה, מה יוצא). אם רלוונטי, ציין אם זה רץ על ציר זמן (משימה מתוזמנת) או ביוזמת הסוכן.
**מה אומרים לסוכן (בלוק הוראה מוכן להדבקה):**
> <בלוק טקסט שהמשתמש מדביק פעם אחת כדי ללמד את הסוכן את הפלואו. גוף שני אל הסוכן, ברור ומדויק, לפי השלבים. אם הפלואו חוזר, כלול מתי ובאיזה קצב.>
**כיול (שאלה-תשובה):**
Q: <שאלה שהסוכן שואל כדי להתאים אישית>
A: <דוגמת תשובה>
(2 עד 4 זוגות Q/A)
**מתי מפעילים (סנריוס לשימוש):** 3 עד 5 משפטי הפעלה קצרים.
**רמת חיבור:** אפס-חיבור / אופציונלי חיבור <X>.
**כמה אפקטיבי ושונה:** משפט או שניים, מול ידני ומול ChatGPT רגיל.

הקפד: בלי מקפים ארוכים, בלי סימני AI, מסגור חיובי.
`
const sections = (await parallel(selected.map((f) => () =>
  agent(
    `${CONTEXT}\n\nפתח לגמרי את הפלואו הבא לכדי ארטיפקט מלא של "למד את הסוכן":\n` +
    `שם: ${f.name}\nרגע: ${f.moment}\nמכניקה: ${f.mechanic}\nחיבור: ${f.connection}\n\n${FORMAT}`,
    { label: `dev:${f.name}`, phase: 'Develop', schema: DEV_SCHEMA }
  )
))).filter(Boolean)
log(`פותחו ${sections.length} מקטעים`)

phase('Synthesize')
const synth = await agent(
  `${CONTEXT}\n\nפותחו ${sections.length} פלואוז חדשים (סבב שני, פוקוס על פרואקטיבי/חוזר, יועץ, טריאז', אישי, סקיילינג). שמות:\n` +
  `${sections.map(s => '- ' + s.name).join('\n')}\n\n` +
  `כתוב שלושה חלקים ב-markdown עברית:\n` +
  `1. intro_markdown: פתיח קצר שמסביר שזה הסבב השני, ההבדל המרכזי (מעבר מריאקטיבי ליוזמה על ציר זמן + יועץ + טריאז' + אישי), ואיך משתמשים.\n` +
  `2. effectiveness_markdown: ניתוח כמה זה אפקטיבי ושונה, בדגש על מה שהסבב הראשון לא נתן (יוזמה, קצב, החזקת שגרות לאורך זמן). השווה לידני ול-ChatGPT.\n` +
  `3. meta_ideas_markdown: 5 עד 8 רעיונות-על שעולים מהסבב הזה (למשל: הסוכן כשומר סף של שגרות, קצב במקום פעולה בודדת, מתי יוזמה מרגישה עזרה ומתי הטרדה).\n` +
  `בלי מקפים ארוכים, בלי סימני AI.`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA }
)

return {
  count: sections.length,
  names: sections.map(s => s.name),
  intro: synth?.intro_markdown || '',
  effectiveness: synth?.effectiveness_markdown || '',
  meta: synth?.meta_ideas_markdown || '',
  sections: sections.map(s => s.markdown),
}
