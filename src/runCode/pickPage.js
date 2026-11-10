// The page a program starts on, one rule for the run_code helper and the Bash snippet: the tab the human is looking
// at (browser_info's activeTargetId); else, in an attached browser (the user's own), a new tab of the program's own;
// else the first tab. No imports: the snippet loads this file by URL.
export async function pickPage(context, { activeTargetId, kind }) {
  if (activeTargetId) {
    for (const page of context.pages()) {
      const session = await context.newCDPSession(page);
      try {
        const { targetInfo } = await session.send('Target.getTargetInfo');
        if (targetInfo.targetId === activeTargetId) return page;
      } finally {
        await session.detach().catch(() => {});
      }
    }
  }
  if (kind === 'attached') return context.newPage();
  return context.pages()[0] ?? context.newPage();
}
