import { useEffect, useState } from 'react';

// Tracks a CSS media query; false where matchMedia is unavailable.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof matchMedia === 'function' ? matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const mq = matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
