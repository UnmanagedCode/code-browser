import { useEffect, useState } from 'react';

interface Props { url: string; hasControl: boolean; onGo(url: string): void }

export function UrlBar({ url, hasControl, onGo }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [url]);
  return (
    <form
      className="url-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft !== null && draft.trim() !== '') onGo(draft);
        setDraft(null);
      }}
    >
      <input
        type="text"
        aria-label="Address"
        value={draft ?? url}
        readOnly={!hasControl}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
      />
    </form>
  );
}
