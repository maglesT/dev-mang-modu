import { describe, expect, it } from 'vitest';
import { dmaicPhases } from '../web/src/dmaic.js';

// S11 (D-31): DMAIC phases derived from the deviation step and its CAPAs. A view only.
const states = (step: string, capas: string[] = [], noCapa = '') => dmaicPhases(step, capas, noCapa)!.map((p) => `${p.key}:${p.state}`).join(' ');

describe('DMAIC view (S11)', () => {
  it('S11: each step of a deviation maps to DMAIC phases', () => {
    expect(states('classification')).toBe('D:current M:todo A:todo I:todo C:todo');
    expect(states('approval')).toBe('D:current M:todo A:todo I:todo C:todo');
    expect(states('investigation')).toBe('D:done M:current A:current I:todo C:todo');
    expect(states('investigation', ['open'])).toBe('D:done M:current A:current I:current C:todo');
    // Awaiting closure: CAPAs are raised (Improve) and QA closes, or records "no CAPA" for a minor one (Control).
    expect(states('closure')).toBe('D:done M:done A:done I:current C:current');
    // CAPAs done before the investigation is signed do not move Improve or Control on.
    expect(states('investigation', ['done'])).toBe('D:done M:current A:current I:current C:todo');
    expect(states('closure', ['done', 'check'])).toBe('D:done M:done A:done I:done C:current');
    expect(states('closed', ['closed', 'check'])).toBe('D:done M:done A:done I:done C:current');
    expect(states('closed', ['closed'])).toBe('D:done M:done A:done I:done C:done');
  });

  it('S11: a minor deviation closed with "no CAPA" completes Improve and Control; a rejected one has no phases', () => {
    expect(states('closed', [], 'Immediate action was enough.')).toBe('D:done M:done A:done I:done C:done');
    expect(dmaicPhases('rejected', [], '')).toBeNull();
  });
});
