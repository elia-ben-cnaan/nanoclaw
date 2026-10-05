import { describe, expect, it } from 'bun:test';

import { userFacingErrorText } from './poll-loop.js';

describe('userFacingErrorText', () => {
  it('pilots never see raw English errors', () => {
    for (const e of ["You've hit your session limit · resets 3am", 'API Error: Overloaded', 'Claude Code process exited with code 1']) {
      const t = userFacingErrorText(e, 'ag-pilot-123');
      expect(t).not.toContain('Error');
      expect(t).toMatch(/[֐-׿]/);
    }
    expect(userFacingErrorText('x', undefined)).toMatch(/[֐-׿]/);
  });
  it('operator agents keep the raw error for debugging', () => {
    expect(userFacingErrorText('API Error: Overloaded', 'ag-1778670984219-665dop')).toBe('Error: API Error: Overloaded');
  });
});
