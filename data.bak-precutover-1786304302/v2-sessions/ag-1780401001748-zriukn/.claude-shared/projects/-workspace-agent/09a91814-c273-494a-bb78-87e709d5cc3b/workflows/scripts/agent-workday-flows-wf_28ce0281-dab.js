export const meta = {
  name: 'agent-workday-flows',
  description: 'Generate many per-person workday flows for the agent, each as a teach-the-agent Q&A block + usage scenarios + effectiveness read',
  phases: [
    { title: 'Generate' },
    { title: 'Select' },
    { title: 'Develop' },
    { title: 'Synthesize' },
  ],
}

const CONTEXT = `
מוצר: סוכן AI אישי (NanoClaw) לאדם עובד.
הרפריים המרכזי: הסוכן הוא לא תחליף ל-ChatGPT. הוא ה"פעולה הרוחבית" / המייל האחרון / שכבת הזיכרון סביב העבודה הקיימת. המשתמש ממשיך לעבוד רגיל, מייצר תוצרים בכלים שלו (ChatGPT, כלי הקלטה, כלי מחקר), ואז נותן לסוכן את התוצר והסוכן לוקח אותו הלאה: הופך למייל שנשלח, פגישה שזומנה, הודעת וואטסאפ מוכנה, הכנה לפגישה, מסמך ללקוח. הרבה מזה בלי חיבור לשום מערכת (קישורי compose של Gmail, קישורי תבנית של Google Calendar עם add=email, ICS, forward של תמלול). הסוכן גם זוכר את שגרת העבודה: מי מחכה לתשובה, אילו פולואפים בשלים, מה על השולחן. מסלול שדרוג: כשהמשתמש מוכן מחברים כלי הקלטה/מייל/יומן והזרימות הופכות אוטומטיות במקום העתק-הדבק.

הכאב: ChatGPT אפיזודי וחסר זיכרון, והתוצר נשאר בצ'אט. יש "מייל אחרון" של העתק-הדבק-עצב-שלח שאוכל זמן. אנשים פוחדים לחבר מערכות. הערך אינו "לייצר תוכן" (כולם יודעים) אלא: זיכרון של העבודה + השלמת המייל האחרון + אפס חיכוך חיבור.

כללי כתיבה מחייבים: עברית טבעית וזורמת, בלי מקפים ארוכים (em-dash), בלי שום סימן שנכתב ע"י AI, מסגור per-בן-אדם ולא per-תפקיד, מסגור חיובי (איך כן, לא איך לא).
`

const IDEA_SCHEMA = {
  type: 'object',
  properties: {
    flows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'שם קצר לפלואו בעברית' },
          moment: { type: 'string', description: 'הרגע/הכאב האנושי שהוא פותר, משפט' },
          mechanic: { type: 'string', description: 'המכניקה בשורה: מה נכנס ומה יוצא' },
          connection: { type: 'string', description: 'אפס-חיבור / אופציונלי חיבור <X>' },
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
          why: { type: 'string', description: 'למה נבחר, ערך ייחודי' },
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
    markdown: { type: 'string', description: 'מקטע markdown מלא בעברית לפלואו הזה, בפורמט המבוקש' },
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
  { key: 'תקשורת ופולואפ', seed: 'מייל, וואטסאפ, פולואפ אחרי פגישות, ניסוח תשובות, תיאום, הודעות ללקוחות' },
  { key: 'תכנון וזיכרון', seed: 'בריף בוקר, הכנה לפגישה מהזיכרון, מעקב פולואפים, אדמיניסטרציה אישית, זכירת קונטקסט לקוחות לאורך זמן, ניהול משימות' },
  { key: 'עבודת ידע ותוכן', seed: 'הפיכת מחקר לפעולה, מיחזור תוכן, פוסטים, מסמכי החלטה, סיכומים, עמוד ללקוח, הכנת הצעות' },
  { key: 'העברה מכלים אחרים וחיבורים', seed: 'לקחת פלט של ChatGPT ולהמשיך אותו, כלי הקלטה לתמלול לסיכום, מסלול השדרוג של חיבור מערכות, קואצ׳ינג איך לעבוד טוב יותר עם LLM' },
  { key: 'עסק קטן ויומיום', seed: 'בעל עסק עצמאי/יועץ/פרילנסר: הצעות מחיר, חשבוניות-הכנה, תיאומים, ניהול לידים, סיכומי שיחות מכירה, תזכורות' },
]
const rounds = (await parallel(DOMAINS.map((d, i) => () =>
  agent(
    `${CONTEXT}\n\nאתה מחולל רעיונות לפלואוז של עבודה יומיומית שהסוכן מייעל. תחום מיקוד: "${d.key}" (${d.seed}).\n` +
    `תן 8 עד 10 פלואוז נבדלים וקונקרטיים. כל פלואו = רגע אנושי אמיתי ביום עבודה, המכניקה (מה נכנס ומה יוצא), ורמת החיבור. ` +
    `דגש: רובם צריכים להיות אפס-חיבור. תהיה יצירתי ותגיע לכמה שיותר רעיונות איכותיים ומעשיים.`,
    { label: `gen:${d.key}`, phase: 'Generate', schema: IDEA_SCHEMA }
  )
))).filter(Boolean).flatMap(r => r.flows)

log(`נוצרו ${rounds.length} רעיונות גולמיים על פני ${DOMAINS.length} תחומים`)

phase('Select')
const pick = await agent(
  `${CONTEXT}\n\nלהלן ${rounds.length} רעיונות גולמיים לפלואוז:\n${JSON.stringify(rounds, null, 2)}\n\n` +
  `אחד כפילויות, מזג דומים, ובחר את הסט הכי חזק ונבדל של 16 עד 20 פלואוז. ` +
  `קריטריון: ערך ייחודי אמיתי (זיכרון + מייל אחרון + אפס חיכוך), per-בן-אדם, מגוון על פני הרגעים ביום העבודה, לא חופף. ` +
  `העדף רוב אפס-חיבור עם כמה פלואוז של מסלול שדרוג. דרג מהחזק לפחות.`,
  { label: 'select', phase: 'Select', schema: SELECT_SCHEMA }
)
const selected = (pick?.selected || []).slice(0, 20)
log(`נבחרו ${selected.length} פלואוז לפיתוח מלא`)

phase('Develop')
const FORMAT = `
פורמט חובה לכל מקטע (markdown, עברית):

### <שם הפלואו>
**הרגע:** <הרגע/הכאב האנושי, משפט או שניים>
**איך זה עובד:** רשימה ממוספרת של שלבי הזרימה (מה נכנס, מה הסוכן עושה, מה יוצא).
**מה אומרים לסוכן (בלוק הוראה מוכן להדבקה):**
> <בלוק טקסט שהמשתמש מדביק פעם אחת כדי ללמד את הסוכן את הפלואו הזה. כתוב בגוף שני אל הסוכן, ברור ומדויק, לפי השלבים.>
**כיול (שאלה-תשובה):**
Q: <שאלה שהסוכן שואל כדי להתאים אישית>
A: <דוגמת תשובה>
(2 עד 4 זוגות Q/A)
**מתי מפעילים (סנריוס לשימוש):** 3 עד 5 משפטי הפעלה קצרים שהמשתמש יגיד כדי להריץ את הפלואו אחרי שנלמד.
**רמת חיבור:** אפס-חיבור / אופציונלי חיבור <X>.
**כמה אפקטיבי ושונה:** משפט או שניים, מול לעשות את זה ידנית ומול ChatGPT רגיל.

הקפד: בלי מקפים ארוכים, בלי סימני AI, מסגור חיובי.
`
const sections = (await parallel(selected.map((f, i) => () =>
  agent(
    `${CONTEXT}\n\nפתח לגמרי את הפלואו הבא לכדי ארטיפקט מלא של "למד את הסוכן":\n` +
    `שם: ${f.name}\nרגע: ${f.moment}\nמכניקה: ${f.mechanic}\nחיבור: ${f.connection}\n\n${FORMAT}`,
    { label: `dev:${f.name}`, phase: 'Develop', schema: DEV_SCHEMA }
  )
))).filter(Boolean)
log(`פותחו ${sections.length} מקטעים מלאים`)

phase('Synthesize')
const synth = await agent(
  `${CONTEXT}\n\nפותחו ${sections.length} פלואוז מלאים לעבודה יומיומית עם הסוכן. שמות הפלואוז:\n` +
  `${sections.map(s => '- ' + s.name).join('\n')}\n\n` +
  `כתוב שלושה חלקים ב-markdown עברית:\n` +
  `1. intro_markdown: פתיח קצר וחד שמסביר את הרעיון של "פלואוז" ואת הרפריים (הסוכן = הפעולה הרוחבית סביב העבודה, לא תחליף ל-LLM), ואיך משתמשים במסמך.\n` +
  `2. effectiveness_markdown: ניתוח כמה זה אפקטיבי ושונה מכל התהליך הקיים. השווה ל: (א) לעשות ידנית, (ב) ChatGPT רגיל בלי זיכרון ובלי מייל אחרון, (ג) חיבור מלא של מערכות מההתחלה. הצג את שלושת מקורות הערך (זיכרון + מייל אחרון + אפס חיכוך) עם דוגמאות של חיסכון זמן היכן שסביר.\n` +
  `3. meta_ideas_markdown: 5 עד 8 רעיונות-על נוספים ורוחביים שלא נתפסו כפלואו בודד (למשל דפוסים חוזרים, עקרונות לימוד הסוכן, איך להציג את זה במדריך/אפליקציה לפני הורדה).\n` +
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
