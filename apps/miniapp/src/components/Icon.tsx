
// Набор контурных иконок 24×24 (в стиле Lucide), чтобы не тянуть отдельную библиотеку.
const ICONS = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </>
  ),
  card: (
    <>
      <rect x={2} y={5} width={20} height={14} rx={3} />
      <path d="M2 10h20M6 15h4" />
    </>
  ),
  history: (
    <>
      <circle cx={12} cy={12} r={9} />
      <path d="M12 7v5l3 2" />
    </>
  ),
  user: (
    <>
      <circle cx={12} cy={8} r={4} />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  arrowDown: <path d="M12 4v16M5 13l7 7 7-7" />,
  arrowUp: <path d="M12 20V4M5 11l7-7 7 7" />,
  arrowLeft: <path d="M15 6l-6 6 6 6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  snowflake: <path d="M2 12h20M12 2v20M20 16l-4-4 4-4M4 8l4 4-4 4M16 4l-4 4-4-4M8 20l4-4 4 4" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx={12} cy={12} r={3} />
    </>
  ),
  eyeOff: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <path d="M3 3l18 18" />
    </>
  ),
  copy: (
    <>
      <rect x={9} y={9} width={12} height={12} rx={2} />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  check: <path d="M5 12l5 5 9-10" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  shield: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </>
  ),
  globe: (
    <>
      <circle cx={12} cy={12} r={9} />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </>
  ),
  document: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  bag: (
    <>
      <path d="M5 8h14l-1 12H6L5 8Z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </>
  ),
  alert: (
    <>
      <circle cx={12} cy={12} r={9} />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </>
  ),
  flask: <path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10" />,
  faceId: (
    <>
      <path d="M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M7 21H5a2 2 0 0 1-2-2v-2M17 21h2a2 2 0 0 0 2-2v-2" />
      <path d="M9 9v1.5M15 9v1.5M12 9v4.5h-1M9 16c1.6 1.2 4.4 1.2 6 0" />
    </>
  ),
  fingerprint: (
    <path d="M12 11v3c0 3-.8 5.3-2 7M8.5 10.5a3.5 3.5 0 0 1 7 0V13c0 2.6-.5 4.8-1.5 7M5.5 15v-4a6.5 6.5 0 0 1 11.5-4.2M18.5 10.5V13c0 1.6-.2 3.1-.6 4.5" />
  ),
  backspace: <path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6-7 6-7ZM12.5 9.5l5 5M17.5 9.5l-5 5" />,
  lock: (
    <>
      <rect x={4} y={10} width={16} height={11} rx={2} />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14.5v2.5" />
    </>
  ),
  coins: (
    <>
      <circle cx={9} cy={9} r={6} />
      <path d="M18.1 10.4A6 6 0 1 1 10.4 18.1M8 7h1.2v4" />
    </>
  ),
  phone: (
    <>
      <rect x={6} y={2.5} width={12} height={19} rx={2.5} />
      <path d="M10.5 18.5h3" />
    </>
  ),
  wallet: (
    <>
      <rect x={3} y={6} width={18} height={14} rx={2.5} />
      <path d="M3 10h18M6 3.5h10M15 15h2.5" />
    </>
  ),
  send: <path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z" />,
  arrowUpRight: <path d="M7 17 17 7M8 7h9v9" />,
  exchange: <path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  gift: (
    <>
      <rect x={3} y={8} width={18} height={4} rx={1} />
      <path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M12 8v13M12 8S10.5 3 8 3a2.5 2.5 0 0 0 0 5M12 8s1.5-5 4-5a2.5 2.5 0 0 1 0 5" />
    </>
  ),
  help: (
    <>
      <circle cx={12} cy={12} r={9} />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.01" />
    </>
  ),
  percent: (
    <>
      <path d="M19 5 5 19" />
      <circle cx={7} cy={7} r={2.5} />
      <circle cx={17} cy={17} r={2.5} />
    </>
  ),
  share: <path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />,
  chat: <path d="M4 5h16v11H9l-5 4V5ZM8 9.5h8M8 12.5h5" />,
  megaphone: <path d="M3 10v4h3l7 4V6l-7 4H3ZM17 9a4 4 0 0 1 0 6M6 14l1 6h2.5l-1-5" />,
};

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 22,
  color = 'currentColor',
  strokeWidth = 1.9,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  return (
    // Large icons keep the visual line of a 24px icon instead of growing heavier with their size.
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={size > 24 ? strokeWidth * 24 / size : strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}
