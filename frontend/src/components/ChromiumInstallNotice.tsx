import { useEffect, useRef } from 'react';
import { focusInPanel } from '../focus';
import type { InstallState } from '../protocol';

interface Props {
  // The browser whose start needs Chromium, if known (a notice opened by a reload has none).
  name: string | null;
  // The manual install command from the not-found error, if this notice was opened by one.
  command: string | null;
  install: InstallState | null;
  onInstall(): void;
  onStart(name: string): void;
  onDismiss(): void;
}

const LOG_TITLE = 'Installer output';

// Offers to install Chromium when none was found, then shows the run: its log, and its outcome with a way to retry.
// Everything from the backend (error, log) is a text child, never markup.
export function ChromiumInstallNotice({ name, command, install, onInstall, onStart, onDismiss }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const status = install?.status ?? 'idle';
  // The offer follows a start or create failure: move focus to it, if the panel has focus.
  useEffect(() => {
    if (command !== null) focusInPanel(heading.current);
  }, [command, name]);

  const title = status === 'running' ? 'Installing Chromium…'
    : status === 'succeeded' ? 'Chromium is installed'
      : status === 'failed' ? 'Chromium install failed'
        : 'Chromium is not installed';
  const sentence = status === 'running' ? 'Installing Chromium…'
    : status === 'succeeded' ? 'Chromium is installed.'
      : status === 'failed' ? 'The Chromium install failed.'
        : '';

  return (
    <section className="install-notice" aria-labelledby="install-notice-title">
      <h2 id="install-notice-title" ref={heading} tabIndex={-1}>{title}</h2>
      <p role="status">{sentence}</p>
      {status === 'idle' && (
        <>
          <p>
            code-browser needs Chromium{name !== null && <> to start <strong>{name}</strong></>}. Install downloads Playwright&apos;s Chromium build (a large download) on this host.
          </p>
          {command !== null && <p>Or run it yourself: <code>{command}</code></p>}
          <div className="install-actions">
            <button type="button" data-variant="primary" onClick={onInstall}>Install Chromium</button>
            <button type="button" onClick={onDismiss}>Dismiss</button>
          </div>
        </>
      )}
      {status === 'running' && <pre className="install-log" aria-label={LOG_TITLE}>{install!.logTail}</pre>}
      {status === 'succeeded' && (
        <div className="install-actions">
          {name !== null
            ? <button type="button" data-variant="primary" onClick={() => onStart(name)}>Start {name}</button>
            : <p>Start a browser to use it.</p>}
          <button type="button" onClick={onDismiss}>Dismiss</button>
        </div>
      )}
      {status === 'failed' && (
        <>
          {install!.error !== null && <p>{install!.error}</p>}
          {install!.logTail !== '' && <pre className="install-log" aria-label={LOG_TITLE}>{install!.logTail}</pre>}
          <div className="install-actions">
            <button type="button" data-variant="primary" onClick={onInstall}>Try again</button>
            <button type="button" onClick={onDismiss}>Dismiss</button>
          </div>
        </>
      )}
    </section>
  );
}
