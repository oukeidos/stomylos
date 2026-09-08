import type { ReactNode } from 'react';

const paths = {
  explain: <><path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z" /><path d="M9 8a3 3 0 0 1 6 0c0 2-3 2-3 4" /><path d="M12 15h.01" /></>,
  bookmark: <path d="M6 3h12v18l-6-4-6 4Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  book: <><path d="M12 5v15M3 4h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v15h-5a5 5 0 0 0-4 1 5 5 0 0 0-4-1H3Z" /></>,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  help: <><path d="m4 20 11-11 4 4L8 24ZM14 3v4M12 5h4M20 6v4M18 8h4" transform="translate(0 -3)" /></>,
  mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3M8 21h8" /></>,
  down: <path d="M12 4v16m-7-7 7 7 7-7" />,
  send: <path d="M12 20V4m-7 7 7-7 7 7" />,
  globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
  globeOff: <><path d="M8 3.9A9 9 0 0 1 20.1 16M16 20.1A9 9 0 0 1 3.9 8M12 3c3 3 4 6 4 9M8 12c0 4 2 7 4 9M3 12h9m5 0h4M3 3l18 18" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>,
  speaker: <><path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></>,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  play: <path d="m8 4 12 8-12 8Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  back: <path d="M20 12H4m7-7-7 7 7 7" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v.1" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  exit: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M9 12h12m-5-5 5 5-5 5" /></>,
  apply: <path d="M20 4v8a3 3 0 0 1-3 3H4m5-5-5 5 5 5" />,
  undo: <><path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12h-3" /></>,
  starter: <><path d="M9 18h6M9 21h6M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4Z" /></>,
  chat: <path d="M21 11a8 8 0 0 1-8 8H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />,
  review: <><path d="m3 6 2 2 3-4m-5 9 2 2 3-4m-5 9 2 2 3-4M12 6h9M12 13h9M12 20h9" /></>,
  target: <><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" /><rect x="8" y="8" width="8" height="8" rx="1" /></>,
} satisfies Record<string, ReactNode>;

export function Icon({ name, className = '' }: { name: keyof typeof paths; className?: string }) {
  return <svg className={`ui-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
