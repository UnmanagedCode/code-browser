// The page a program starts on, one rule for the run_code helper and the Bash snippet: the tab the human is looking
// at (browser_info's activeTargetId); else, in an attached browser (the user's own), a new tab of the program's own;
// else the first tab. A page that cannot be probed (closed since the list was taken) is not a match. No imports: the
// snippet loads this file by URL.
export async function pickPage(context, { activeTargetId, kind }) {
  if (activeTargetId) {
    for (const page of context.pages()) {
      if (await targetIdOf(context, page) === activeTargetId) return page;
    }
  }
  if (kind === 'attached') return context.newPage();
  return context.pages()[0] ?? context.newPage();
}

async function targetIdOf(context, page) {
  let session;
  try {
    session = await context.newCDPSession(page);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    return targetInfo.targetId;
  } catch {
    return null;
  } finally {
    await session?.detach().catch(() => {});
  }
}
