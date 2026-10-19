// Stroke icons drawn on a 24px grid (Lucide geometry), inlined so the app needs no icon dependency.
import type { ReactNode, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function Icon({ size = 16, strokeWidth = 2, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const CheckIcon = (p: IconProps) => <Icon {...p}><path d="M20 6 9 17l-5-5" /></Icon>;
export const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Icon>
);
export const CircleCheckIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></Icon>;
export const CircleXIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></Icon>;
export const ClockIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Icon>;
export const ChevronDownIcon = (p: IconProps) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>;
export const XIcon = (p: IconProps) => <Icon {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>;
export const UploadIcon = (p: IconProps) => (
  <Icon {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></Icon>
);
export const FolderOpenIcon = (p: IconProps) => (
  <Icon {...p}><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></Icon>
);
export const BoxIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </Icon>
);
export const MoreIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></Icon>;
export const EyeIcon = (p: IconProps) => (
  <Icon {...p}><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" /><circle cx="12" cy="12" r="3" /></Icon>
);
export const SlidersIcon = (p: IconProps) => (
  <Icon {...p}><path d="M4 7h10" /><path d="M18 7h2" /><path d="M4 17h4" /><path d="M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></Icon>
);
export const PlayIcon = (p: IconProps) => <Icon {...p}><path d="M6 3.5v17l14-8.5z" /></Icon>;
export const SquareIcon = (p: IconProps) => <Icon {...p}><rect x="6" y="6" width="12" height="12" rx="1" /></Icon>;
export const GridIcon = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></Icon>
);
export const BrushIcon = (p: IconProps) => (
  <Icon {...p}><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" /><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" /></Icon>
);
export const DownloadIcon = (p: IconProps) => (
  <Icon {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></Icon>
);
