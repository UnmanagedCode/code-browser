import { describe, expect, it } from 'vitest';
import { splitCode } from './api';
import { toToast } from './errorText';
import { NAME_HINT } from './names';

describe('toToast', () => {
  // Invariant: codes whose backend text adds nothing become a plain sentence, with the code kept as detail.
  it('maps known codes to plain wording', () => {
    expect(toToast('NOT_CONTROLLER', 'take control first')).toEqual({ text: 'Take control first.', code: 'NOT_CONTROLLER' });
    expect(toToast('CDP_TIMEOUT', 'x').text).toBe('The browser stopped responding.');
    expect(toToast('INVALID_NAME', 'x').text).toBe(NAME_HINT);
  });

  // Invariant: any other code keeps the backend's specifics (first letter upper-cased).
  it('passes other codes through', () => {
    expect(toToast('ATTACH_FAILED', 'could not reach 127.0.0.1:9222')).toEqual({ text: 'Could not reach 127.0.0.1:9222', code: 'ATTACH_FAILED' });
  });

  // Invariant: an uncoded error has no code detail.
  it('uncoded errors have no code', () => {
    expect(toToast(null, 'request failed (500)')).toEqual({ text: 'Request failed (500)', code: null });
    expect(toToast('constructor', 'x').text).toBe('X');
  });
});

describe('splitCode', () => {
  // Invariant: one parser splits "CODE: message" and leaves other text whole.
  it('splits a prefixed message', () => {
    expect(splitCode('NO_TAB: no such tab')).toEqual({ code: 'NO_TAB', message: 'no such tab' });
    expect(splitCode('Failed to fetch')).toEqual({ code: null, message: 'Failed to fetch' });
  });
});
