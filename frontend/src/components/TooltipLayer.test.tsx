import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipLayer } from './TooltipLayer';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup(tip = 'Reload') {
  render(<><TooltipLayer /><button type="button" aria-label="Reload" data-tip={tip}>x</button></>);
  return screen.getByRole('button', { name: 'Reload' });
}
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('TooltipLayer', () => {
  // Invariant: a tooltip appears only after the hover delay, shows the data-tip text, and goes when the pointer leaves.
  it('shows after the delay on hover and hides on pointer out', () => {
    const b = setup();
    fireEvent.pointerOver(b);
    wait(299);
    expect(screen.queryByRole('tooltip')).toBeNull();
    wait(1);
    expect(screen.getByRole('tooltip').textContent).toBe('Reload');
    fireEvent.pointerOut(b);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  // Invariant: leaving before the delay cancels the tooltip.
  it('does not show when the pointer leaves before the delay', () => {
    const b = setup();
    fireEvent.pointerOver(b);
    wait(100);
    fireEvent.pointerOut(b);
    wait(500);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  // Invariant: keyboard focus shows the tooltip too, and Escape dismisses it.
  it('shows on focus and hides on Escape', () => {
    const b = setup();
    fireEvent.focusIn(b);
    wait(300);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  // Invariant: tip text is page-influenced (tab titles) and only ever becomes text, never markup.
  it('renders a hostile tip as literal text', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const b = setup(hostile);
    fireEvent.pointerOver(b);
    wait(300);
    expect(screen.getByRole('tooltip').textContent).toBe(hostile);
    expect(document.querySelector('img')).toBeNull();
  });
});
