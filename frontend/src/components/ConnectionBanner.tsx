import type { SocketStatus } from '../socket';

interface Props { status: SocketStatus; failures: number; onRetry(): void }

// Shown from the first failed attempt until the socket is open again, so the first page load never flashes it.
export function ConnectionBanner({ status, failures, onRetry }: Props) {
  if (status === 'open' || failures === 0) return null;
  return (
    <div className="connection-banner" role="status">
      <span>
        {status === 'closed'
          ? `Lost the connection to code-browser. Retrying (attempt ${failures})…`
          : `Reconnecting to code-browser (attempt ${failures})…`}
      </span>
      {status === 'closed' && <button type="button" data-size="sm" onClick={onRetry}>Retry now</button>}
    </div>
  );
}
