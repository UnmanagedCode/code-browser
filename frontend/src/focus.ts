// Moves focus only while this document already has it: embedded in cc, the panel must never take focus from the host.
export function focusInPanel(el: HTMLElement | null | undefined): boolean {
  if (!el || !document.hasFocus()) return false;
  el.focus();
  return true;
}
