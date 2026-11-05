import { useEffect, useRef } from 'react';
import type { SocketStatus } from '../socket';

interface Props { status: SocketStatus; failures: number; onRetry(): void }

// Shown from the first failed attempt until the socket is open again, so the first page load never flashes it.
// The announcement is a separate, always-mounted live region with one stable phrase, so a retry is not re-read.
export function ConnectionBanner({ status, failures, onRetry }: Props) {
  const shown = status !== 'open' && failures > 0;
  const wasShown = useRef(false);
  // Whether the banner has shown at least once: the phrase after it is the reconnect notice.
  const live = shown
    ? 'Lost the connection to code-browser. Reconnecting…'
    : wasShown.current ? 'Reconnected to code-browser.' : '';
  useEffect(() => { if (shown) wasShown.current = true; }, [shown]);
  return (
    <>
      <p className="sr-only" role="status">{live}</p>
      {shown && (
        <div className="connection-banner">
          <span>
            {status === 'closed'
              ? `Lost the connection to code-browser. Retrying (attempt ${failures})…`
              : `Reconnecting to code-browser (attempt ${failures})…`}
          </span>
          {status === 'closed' && <button type="button" data-size="sm" onClick={onRetry}>Retry now</button>}
        </div>
      )}
    </>
  );
}
