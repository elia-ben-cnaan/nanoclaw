/**
 * Delivery-time guard for prepared action links.
 *
 * Agents occasionally fall back to a normal text message containing an action
 * URL after a card delivery is uncertain.  That makes long encoded URLs leak
 * into the chat.  Convert only known, user-facing action links into the
 * existing card contract.  Informational URLs deliberately remain text.
 */

export interface ActionCardPromotion {
  content: Record<string, unknown>;
  promoted: boolean;
}

interface ActionDescriptor {
  title: string;
  description: string;
  label: string;
}

const ACTION_URL_PATTERN = /https:\/\/[^\s<>"`]+/gi;

function descriptorForActionUrl(rawUrl: string): ActionDescriptor | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  if (host === 'calendar.google.com' && path.includes('/calendar/render')) {
    return { title: '📅 זימון מוכן', description: 'הזימון מוכן להוספה ליומן.', label: 'הוסף ליומן' };
  }
  if (host === 'wa.me' || host.endsWith('.wa.me')) {
    return { title: '🟢 הודעה מוכנה', description: 'ההודעה מוכנה לשליחה.', label: 'פתח בוואטסאפ' };
  }
  if (host === 'waze.com' || host.endsWith('.waze.com') || host.includes('maps.google')) {
    return { title: '🚗 ניווט מוכן', description: 'הניווט מוכן לפתיחה.', label: 'פתח ניווט' };
  }
  if (host === 'meet.google.com' || host.endsWith('.zoom.us')) {
    return { title: '🎥 פגישה מוכנה', description: 'קישור הפגישה מוכן לפתיחה.', label: 'פתח פגישה' };
  }
  if (host === 'teams.microsoft.com') {
    return { title: '💬 הודעת Teams מוכנה', description: 'הפעולה מוכנה לפתיחה.', label: 'פתח Teams' };
  }
  if (host === 'mail.google.com' || host === 'outlook.office.com' || host === 'outlook.live.com') {
    return { title: '📧 מייל מוכן', description: 'טיוטת המייל מוכנה לפתיחה.', label: 'פתח מייל' };
  }
  if (host === 'c2a-send.vercel.app') {
    const type = url.searchParams.get('t');
    if (type === 'email' || type === 'outlook') {
      return { title: '📧 מייל מוכן', description: 'טיוטת המייל מוכנה לפתיחה.', label: 'פתח מייל' };
    }
    if (type === 'wa' || type === 'whatsapp') {
      return { title: '🟢 הודעה מוכנה', description: 'ההודעה מוכנה לשליחה.', label: 'פתח בוואטסאפ' };
    }
    if (type === 'cal' || type === 'calendar') {
      return { title: '📅 זימון מוכן', description: 'הזימון מוכן להוספה ליומן.', label: 'הוסף ליומן' };
    }
  }

  return null;
}

/**
 * Promote a single known action URL from a normal text message to a card.
 * Do not touch a real card, non-text payload, multiple URLs, or information
 * links.  This keeps the distinction between an action and a normal source.
 */
export function promoteActionLinkToCard(content: Record<string, unknown>): ActionCardPromotion {
  if (content.type === 'card') return { content, promoted: false };

  const text = typeof content.markdown === 'string' ? content.markdown : typeof content.text === 'string' ? content.text : '';
  const urls = text.match(ACTION_URL_PATTERN) ?? [];
  if (urls.length !== 1) return { content, promoted: false };

  const url = urls[0].replace(/[.,!?;:)}\]>]+$/, '');
  const descriptor = descriptorForActionUrl(url);
  if (!descriptor) return { content, promoted: false };

  // Remove the original text fields entirely.  Keeping them alongside a card
  // is unsafe because a future or fallback adapter may choose text over card.
  const { text: _text, markdown: _markdown, ...safeContent } = content;
  return {
    content: {
      ...safeContent,
      type: 'card',
      card: {
        title: descriptor.title,
        description: descriptor.description,
        actions: [{ label: descriptor.label, url }],
      },
      fallbackText: 'לא הצלחתי להציג את כרטיס הפעולה. אפשר לנסות שוב.',
    },
    promoted: true,
  };
}
