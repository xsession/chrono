import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "activity"
  | "branch"
  | "changes"
  | "check"
  | "chevronLeft"
  | "chevronRight"
  | "command"
  | "compare"
  | "download"
  | "file"
  | "eye"
  | "history"
  | "layers"
  | "minus"
  | "refresh"
  | "repository"
  | "search"
  | "settings"
  | "stash"
  | "submodule"
  | "upload"
  | "users"
  | "warning"
  | "worktree";

type Props = SVGProps<SVGSVGElement> & { name: IconName };

const paths: Record<IconName, ReactNode> = {
  activity: <path d="M3 12h3l2-5 4 10 2-5h7" />,
  branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 12h4a6 6 0 0 0 6-6"/></>,
  changes: <><path d="M4 7h10M4 12h16M4 17h10"/><path d="m16 5 3 2-3 2M16 15l3 2-3 2"/></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  command: <><path d="M8 8V6a2 2 0 1 0-2 2h12a2 2 0 1 0-2-2v12a2 2 0 1 0 2-2H6a2 2 0 1 0 2 2V6"/></>,
  compare: <><path d="M7 7h11l-3-3M17 17H6l3 3"/><path d="m18 7-3 3M6 17l3-3"/></>,
  download: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></>,
  file: <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
  history: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8"/><path d="M4 4v4h4M12 8v5l3 2"/></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>,
  minus: <path d="M5 12h14" />,
  refresh: <><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.4 9A7 7 0 0 0 6 6.6L4 9M5.6 15A7 7 0 0 0 18 17.4L20 15"/></>,
  repository: <><path d="M5 4h12a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2V4Z"/><path d="M7 4v15M10 8h6"/></>,
  search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2.1-.7a7 7 0 0 0-.8-1.8l1-2-2.1-2.1-2 1a7 7 0 0 0-1.8-.8L10.5 2h-3l-.7 2.1a7 7 0 0 0-1.8.8l-2-1L.9 6l1 2a7 7 0 0 0-.8 1.8L-1 10.5v3l2.1.7a7 7 0 0 0 .8 1.8l-1 2L3 20.1l2-1a7 7 0 0 0 1.8.8l.7 2.1h3l.7-2.1a7 7 0 0 0 1.8-.8l2 1 2.1-2.1-1-2a7 7 0 0 0 .8-1.8L19 13.5Z" transform="translate(2 0) scale(.9)"/></>,
  stash: <><path d="M4 7h16v13H4z"/><path d="M7 4h10l2 3H5l2-3ZM9 12h6"/></>,
  submodule: <><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M11 7h5a2 2 0 0 1 2 2v4M13 17H8a2 2 0 0 1-2-2v-4"/></>,
  upload: <><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 4h14"/></>,
  users: <><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M14 15a5 5 0 0 1 7 5"/></>,
  warning: <><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5M12 17h.01"/></>,
  worktree: <><path d="M4 5h6v6H4zM14 13h6v6h-6z"/><path d="M10 8h4a3 3 0 0 1 3 3v2M7 11v3a3 3 0 0 0 3 3h4"/></>
};

export function Icon({ name, className = "", ...props }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={`ux-icon ${className}`.trim()}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
