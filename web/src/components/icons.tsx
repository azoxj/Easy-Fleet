import type { SVGProps } from "react";

const PATHS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5M5 9.5V20h14V9.5M10 20v-6h4v6",
  inbox: "M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6l2-8z",
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z",
  truck: "M2 6h12v10H2zM14 9h4l3.5 3.5V16H14M6 19.3a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zM17.5 19.3a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z",
  clipboard: "M9 4h6v3H9zM7 5.5H5.5V21h13V5.5H17M9 12h6M9 16h4",
  users: "M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6",
  shield: "M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6zM9 12l2 2 4-4",
  log: "M6 3h12v18H6zM9 8h6M9 12h6M9 16h3",
  wrench: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  key: "M15 9a4 4 0 1 1-2.8 6.9L10 18H8v2H5v-3l4.1-4.1A4 4 0 0 1 15 9zM16 12h.01",
  alert: "M12 3.5 2.5 20h19zM12 10v4.5M12 17.5h.01",
  ticket: "M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4zM13 7v10",
  fuel: "M4 20V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M3 20h12M6 8h6M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8l-3-3",
  id: "M3 5h18v14H3zM8.5 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5.5 16a3 3 0 0 1 6 0M14 9h4M14 13h4",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  bell: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20.5a2 2 0 0 0 4 0",
  menu: "M4 6h16M4 12h16M4 18h16",
  x: "M6 6l12 12M18 6 6 18",
  plus: "M12 5v14M5 12h14",
  chevron: "m9 6 6 6-6 6",
  back: "m15 6-6 6 6 6",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  lock: "M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  check: "m5 12.5 4.5 4.5L19 7",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  archive: "M3 5h18v4H3zM5 9v11h14V9M10 13h4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  gauge: "M12 14l4-4M3.5 18a9 9 0 1 1 17 0",
  calendar: "M3 5h18v16H3zM3 10h18M8 3v4M16 3v4",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  file: "M14 3H6v18h12V7l-4-4zM14 3v4h4M9 13h6M9 17h6",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  map: "M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5zM9 4v13.5M15 6.5V20",
  pin: "M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM16 16h2v2h-2z",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  chart: "M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-8",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.4z",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  printer: "M7 8V3h10v5M5 8h14v8h-3v5H8v-5H5zM8 14h8",
  stamp: "M9 3h6v6l2 3H7l2-3zM5 14h14v3H5zM5 20h14",
  navigation: "M12 2 4 21l8-4 8 4z",
  building: "M4 21V4h10v17M14 9h6v12M8 8h2M8 12h2M8 16h2M17 13h1M17 17h1",
  play: "M7 4v16l13-8z",
  stop: "M6 6h12v12H6z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  copy: "M8 8h12v12H8zM4 16V4h12",
  minus: "M5 12h14",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  crosshair: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 2v4M12 18v4M2 12h4M18 12h4",
  filter: "M3 5h18l-7 8.5V19l-4 2v-7.5z",
  signal: "M5 19a10 10 0 0 1 14 0M8 15.5a5.5 5.5 0 0 1 8 0M12 12h.01M2 8.5a15 15 0 0 1 20 0",
  speed: "M4 16a8 8 0 1 1 16 0M12 16l4-5M3 16h2M19 16h2",
  route: "M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7",
  arrow: "M5 12h14M13 6l6 6-6 6",
};

export function Icon({ name, className = "", ...rest }: { name: string; className?: string } & SVGProps<SVGSVGElement>) {
  // Default to size-5 unless the caller sets an explicit size.
  const cls = /(^|\s)size-/.test(className) ? className : `size-5 ${className}`.trim();
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={cls} {...rest}>
      <path d={PATHS[name] ?? PATHS.x} />
    </svg>
  );
}
