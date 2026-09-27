import { describe, expect, it } from 'vitest';

import { promoteActionLinkToCard } from './action-link-guard.js';

describe('promoteActionLinkToCard', () => {
  it('converts one calendar action URL from normal text into a compact card', () => {
    const result = promoteActionLinkToCard({
      text: 'הזימון מוכן https://calendar.google.com/calendar/render?action=TEMPLATE&text=test',
    });

    expect(result.promoted).toBe(true);
    expect(result.content.type).toBe('card');
    expect(result.content.card).toEqual({
      title: '📅 זימון מוכן',
      description: 'הזימון מוכן להוספה ליומן.',
      actions: [
        {
          label: 'הוסף ליומן',
          url: 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=test',
        },
      ],
    });
  });

  it('does not convert an informational link', () => {
    const content = { text: 'המקור כאן https://example.com/report' };
    expect(promoteActionLinkToCard(content)).toEqual({ content, promoted: false });
  });

  it('does not alter an existing card or a message with several links', () => {
    const card = { type: 'card', card: { title: 'קיים' } };
    expect(promoteActionLinkToCard(card)).toEqual({ content: card, promoted: false });
    expect(
      promoteActionLinkToCard({
        text: 'https://calendar.google.com/calendar/render?action=TEMPLATE https://example.com',
      }).promoted,
    ).toBe(false);
  });
});
