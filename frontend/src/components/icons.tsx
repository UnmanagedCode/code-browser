// Icon paths from Lucide (https://lucide.dev), ISC License.
import type { ReactNode } from 'react';

const icon = (children: ReactNode) => function Icon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
};

export const ChevronLeftIcon = icon(<path d="m15 18-6-6 6-6" />);
export const ArrowLeftIcon = icon(<><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></>);
export const ArrowRightIcon = icon(<><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>);
export const RotateCwIcon = icon(<><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></>);
export const KeyboardIcon = icon(
  <>
    <path d="M10 8h.01" /><path d="M12 12h.01" /><path d="M14 8h.01" /><path d="M16 12h.01" /><path d="M18 8h.01" /><path d="M6 8h.01" />
    <path d="M7 16h10" /><path d="M8 12h.01" /><rect width="20" height="16" x="2" y="4" rx="2" />
  </>,
);
export const SquareIcon = icon(<rect width="18" height="18" x="3" y="3" rx="2" />);
export const EllipsisIcon = icon(<><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>);
