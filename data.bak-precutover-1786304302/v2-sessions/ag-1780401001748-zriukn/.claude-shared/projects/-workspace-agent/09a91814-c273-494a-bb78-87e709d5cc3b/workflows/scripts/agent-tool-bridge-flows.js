export const meta = {
  name: 'agent-tool-bridge-flows',
  description: 'The agent as the connective layer over popular AI tools — which tools, which actions, which outputs; broad out-of-the-box loop',
  phases: [
    { title: 'Generate' },
    { title: 'Select' },
    { title: 'Develop' },
    { title: 'Synthesize' },
  ],
}

const CONTEXT = `
מוצר: סוכן AI אישי (NanoClaw) לאדם עובד.
הכיוון בסבב הזה (רעיון של אליה): הסוכן הוא שכבת החיבור מעל כלי ה-AI הפופולריים שאנשים כבר מייצרים בהם תוצרים. הרעיון המרכזי: מי שמחבר את הסוכן לכלים האלה או פשוט מוסר לו את התוצר שלהם, מקבל יותר יכולת מהכלי עצמו, כי לסוכן יש זיכרון, קול אישי, הפצה, ושרשור בין כלים. הכלי מייצר, הסוכן לוקח הלאה והופך את זה למשהו שנשלח, נשמר, מתוזמן, או מוזרם לכלי הבא.

דוגמאות לכלים פופולריים: ChatGPT, Claude, Gemini, Perplexity (טקסט, מחקר, ניתוח, קוד); Midjourney, DALL-E, Ideogram, Canva AI (תמונות ועיצוב); Sora, Runway, Kling, HeyGen (וידאו ואווטארים); ElevenLabs, Suno, Udio (קול, מוזיקה, דיבוב); Gamma, Tome, Beautiful.ai (מצגות); Notion AI, Napkin (מסמכים ותרשימים); כלי תמלול (Otter, Fireflies).

הרפריים: הסוכן הוא הפעולה הרוחבית והמייל האחרון. אתה ממשיך ליצור בכלים שאתה אוהב, ומוסר לסוכן את התוצר. הסוכן: (א) מתאים לקול/מותג שלך, (ב) מפיץ לכל ערוץ (מייל, וואטסאפ, לינקדאין, יומן), (ג) זוכר איזה תוצרים יש לך ומשתמש חוזר בהם, (ד) משרשר כלים יחד (פלט של כלי אחד הופך לקלט של הבא), (ה) מתזמן ומפרסם על ציר זמן. הרבה מזה אפס-חיבור (העתקת הפלט/לינק לסוכן), וחלק במסלול שדרוג של חיבור אמיתי.

תחשוב מחוץ לקופסה ורחב: לא רק "לקחת טקסט מ-ChatGPT". תחשוב על שרשראות רב-כליות (Midjourney תמונה + ElevenLabs קול + Sora וידאו + הסוכן מרכיב ומפרסם), על מאגר נכסים שהסוכן מנהל, על הפיכת תוצר יצירתי בודד לקמפיין שלם, על שימוש חוזר בזיכרון של כל מה שיצרת.

כללי כתיבה מחייבים: עברית טבעית וזורמת, בלי מקפים ארוכים (em-dash), בלי סימני AI, מסגור per-בן-אדם ולא per-תפקיד, מסגור חיובי.
`

const IDEA_SCHEMA = {
  type: 'object',
  properties: {
    flows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          tools: { type: 'string', description: 'אילו כלי AI מעורבים' },
          moment: { type: 'string' },
          mechanic: { type: 'string', description: 'מה נכנס (תוצר מהכלי) ומה הסוכן מוציא' },
          connection: { type: 'string' },
        },
        required: ['name', 'tools', 'moment', 'mechanic', 'connection'],
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
          tools: { type: 'string' },
          moment: { type: 'string' },
          mechanic: { type: 'string' },
          connection: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['name', 'tools', 'moment', 'mechanic', 'connection'],
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
  { key: 'כלי טקסט ומחקר', seed: 'ChatGPT, Claude, Gemini, Perplexity — טיוטות, מחקר, ניתוח, קוד, אסטרטגיה. הסוכן לוקח את הפלט ומתאים לקול, מפצל לערוצים, שומר בזיכרון, ממשיך לפעולה שנשלחת' },
  { key: 'כלי תמונה ועיצוב', seed: 'Midjourney, DALL-E, Ideogram, Canva AI — תמונות, לוגו, באנרים, פוסטים. הסוכן מנהל מאגר נכסים, מצמיד קופי, בונה פוסט מלא, מתזמן ומפרסם, שומר את הסגנון החזותי' },
  { key: 'כלי וידאו ואווטאר', seed: 'Sora, Runway, Kling, HeyGen — סרטונים, אווטאר מדבר, רילסים. הסוכן כותב סקריפט, מרכיב עם קול, מכין תיאור וכותרת לכל פלטפורמה, מתזמן' },
  { key: 'כלי קול ומוזיקה', seed: 'ElevenLabs, Suno, Udio, כלי תמלול כמו Otter/Fireflies — הקראה, פודקאסט, דיבוב, מוזיקת רקע, תמלול פגישות. הסוכן הופך תמלול לתוצר שנשלח, טקסט להקלטה שנשלחת בוואטסאפ, מנהל ספריית קול' },
  { key: 'כלי מצגות ומסמכים', seed: 'Gamma, Tome, Beautiful.ai, Notion AI, Napkin — מצגות, מסמכים, תרשימים. הסוכן הופך למסמך שנשלח ללקוח, מכין מייל נלווה, מתזמן פגישת הצגה, שומר גרסאות' },
  { key: 'שרשור רב-כלי ואורקסטרציה', seed: 'הסוכן כמנצח שמשרשר כמה כלים לזרימה אחת: תמונה + קול + וידאו + קופי לקמפיין שלם, מחקר לכתבה למצגת, פלט של כלי אחד כקלט לבא. מאגר נכסים חוצה-כלים, שימוש חוזר, קמפיין מתוצר בודד' },
]
const rounds = (await parallel(DOMAINS.map((d) => () =>
  agent(
    `${CONTEXT}\n\nאתה מחולל רעיונות לפלואוז שבהם הסוכן הוא שכבת החיבור מעל כלי AI. תחום מיקוד: "${d.key}" (${d.seed}).\n` +
    `תן 8 עד 10 פלואוז נבדלים וקונקרטיים. כל פלואו = אילו כלים מעורבים, הרגע האנושי, המכניקה (איזה תוצר נכנס מהכלי ומה הסוכן מוציא הלאה), ורמת החיבור. ` +
    `תחשוב מחוץ לקופסה ורחב, כולל שרשראות רב-כליות ושימוש חוזר בזיכרון. תגיע לכמה שיותר רעיונות איכותיים ומעשיים.`,
    { label: `gen:${d.key}`, phase: 'Generate', schema: IDEA_SCHEMA }
  )
))).filter(Boolean).flatMap(r => r.flows)
log(`נוצרו ${rounds.length} רעיונות גולמיים`)

phase('Select')
const pick = await agent(
  `${CONTEXT}\n\nלהלן ${rounds.length} רעיונות גולמיים:\n${JSON.stringify(rounds, null, 2)}\n\n` +
  `אחד כפילויות, מזג דומים, ובחר את הסט הכי חזק ונבדל של 16 עד 20 פלואוז. ` +
  `קריטריון: ערך ייחודי (הסוכן נותן יותר יכולת מהכלי עצמו דרך זיכרון, קול, הפצה, שרשור), מגוון על פני סוגי כלים, כולל כמה שרשראות רב-כליות שאפ. דרג מהחזק לפחות.`,
  { label: 'select', phase: 'Select', schema: SELECT_SCHEMA }
)
const selected = (pick?.selected || []).slice(0, 20)
log(`נבחרו ${selected.length} פלואוז לפיתוח`)

phase('Develop')
const FORMAT = `
פורמט חובה לכל מקטע (markdown, עברית):

### <שם הפלואו>
**כלים:** <אילו כלי AI מעורבים>
**הרגע:** <הרגע האנושי, משפט או שניים>
**איך זה עובד:** רשימה ממוספרת של שלבי הזרימה (איזה תוצר נכנס מהכלי, מה הסוכן עושה, מה יוצא הלאה ולאן).
**מה אומרים לסוכן (בלוק הוראה מוכן להדבקה):**
> <בלוק טקסט שהמשתמש מדביק פעם אחת כדי ללמד את הסוכן את הפלואו. גוף שני אל הסוכן, ברור ומדויק, לפי השלבים.>
**כיול (שאלה-תשובה):**
Q: <שאלה שהסוכן שואל כדי להתאים אישית>
A: <דוגמת תשובה>
(2 עד 4 זוגות Q/A)
**מתי מפעילים (סנריוס לשימוש):** 3 עד 5 משפטי הפעלה קצרים.
**רמת חיבור:** אפס-חיבור (מדביקים את הפלט/לינק) / אופציונלי חיבור <X>.
**כמה אפקטיבי ושונה:** משפט או שניים — למה עם הסוכן מקבלים יותר יכולת מהכלי לבד.

הקפד: בלי מקפים ארוכים, בלי סימני AI, מסגור חיובי.
`
const sections = (await parallel(selected.map((f) => () =>
  agent(
    `${CONTEXT}\n\nפתח לגמרי את הפלואו הבא לכדי ארטיפקט מלא של "למד את הסוכן":\n` +
    `שם: ${f.name}\nכלים: ${f.tools}\nרגע: ${f.moment}\nמכניקה: ${f.mechanic}\nחיבור: ${f.connection}\n\n${FORMAT}`,
    { label: `dev:${f.name}`, phase: 'Develop', schema: DEV_SCHEMA }
  )
))).filter(Boolean)
log(`פותחו ${sections.length} מקטעים`)

phase('Synthesize')
const synth = await agent(
  `${CONTEXT}\n\nפותחו ${sections.length} פלואוז של הסוכן כשכבת חיבור מעל כלי AI. שמות:\n` +
  `${sections.map(s => '- ' + s.name).join('\n')}\n\n` +
  `כתוב שלושה חלקים ב-markdown עברית:\n` +
  `1. intro_markdown: פתיח קצר על הרעיון — הסוכן מעל הכלים, למה זה נותן יותר יכולת מהכלי לבד, ואיך משתמשים.\n` +
  `2. effectiveness_markdown: ניתוח כמה זה אפקטיבי ושונה. הצג את מקורות הערך: זיכרון של כל התוצרים, קול אחיד, הפצה רב-ערוצית, שרשור בין כלים, מאגר נכסים. השווה למי שמשתמש בכלים לבד בלי סוכן.\n` +
  `3. meta_ideas_markdown: 5 עד 8 רעיונות-על (למשל: מאגר הנכסים כנכס מצטבר, הסוכן כמנצח רב-כלי, קמפיין מתוצר בודד, זהות חזותית/קולית עקבית, מסלול שדרוג לחיבור אמיתי).\n` +
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
