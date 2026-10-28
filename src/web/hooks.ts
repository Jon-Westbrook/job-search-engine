import { useEffect, useState } from 'react';

// The brief's phone breakpoint: 860px and narrower.
const QUERY = '(max-width: 860px)';

export function useSmallScreen(): boolean {
  const [small, setSmall] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setSmall(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return small;
}
