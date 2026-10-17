import Svg, { Circle, Path, Rect } from 'react-native-svg';

// Набор контурных иконок 24×24 (в стиле Lucide), чтобы не тянуть отдельную библиотеку.
const ICONS = {
  home: (
    <>
      <Path d="M3 10.5 12 3l9 7.5" />
      <Path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </>
  ),
  card: (
    <>
      <Rect x={2} y={5} width={20} height={14} rx={3} />
      <Path d="M2 10h20M6 15h4" />
    </>
  ),
  history: (
    <>
      <Circle cx={12} cy={12} r={9} />
      <Path d="M12 7v5l3 2" />
    </>
  ),
  user: (
    <>
      <Circle cx={12} cy={8} r={4} />
      <Path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </>
  ),
  plus: <Path d="M12 5v14M5 12h14" />,
  arrowDown: <Path d="M12 4v16M5 13l7 7 7-7" />,
  arrowUp: <Path d="M12 20V4M5 11l7-7 7 7" />,
  arrowLeft: <Path d="M15 6l-6 6 6 6" />,
  chevronRight: <Path d="M9 6l6 6-6 6" />,
  snowflake: <Path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 2 3-2M9 20l3-2 3 2" />,
  eye: (
    <>
      <Path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <Circle cx={12} cy={12} r={3} />
    </>
  ),
  eyeOff: (
    <>
      <Path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <Path d="M3 3l18 18" />
    </>
  ),
  copy: (
    <>
      <Rect x={9} y={9} width={12} height={12} rx={2} />
      <Path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  check: <Path d="M5 12l5 5 9-10" />,
  close: <Path d="M6 6l12 12M18 6 6 18" />,
  shield: (
    <>
      <Path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z" />
      <Path d="M8.5 12l2.5 2.5 4.5-5" />
    </>
  ),
  globe: (
    <>
      <Circle cx={12} cy={12} r={9} />
      <Path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </>
  ),
  logout: <Path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" />,
  bag: (
    <>
      <Path d="M5 8h14l-1 12H6L5 8Z" />
      <Path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </>
  ),
  alert: (
    <>
      <Circle cx={12} cy={12} r={9} />
      <Path d="M12 7.5v5.5M12 16.5v.01" />
    </>
  ),
  flask: <Path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10" />,
  faceId: (
    <>
      <Path d="M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M7 21H5a2 2 0 0 1-2-2v-2M17 21h2a2 2 0 0 0 2-2v-2" />
      <Path d="M9 9v1.5M15 9v1.5M12 9v4.5h-1M9 16c1.6 1.2 4.4 1.2 6 0" />
    </>
  ),
  fingerprint: (
    <Path d="M12 11v3c0 3-.8 5.3-2 7M8.5 10.5a3.5 3.5 0 0 1 7 0V13c0 2.6-.5 4.8-1.5 7M5.5 15v-4a6.5 6.5 0 0 1 11.5-4.2M18.5 10.5V13c0 1.6-.2 3.1-.6 4.5" />
  ),
  backspace: <Path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6-7 6-7ZM12.5 9.5l5 5M17.5 9.5l-5 5" />,
  lock: (
    <>
      <Rect x={4} y={10} width={16} height={11} rx={2} />
      <Path d="M8 10V7a4 4 0 0 1 8 0v3M12 14.5v2.5" />
    </>
  ),
  coins: (
    <>
      <Circle cx={9} cy={9} r={6} />
      <Path d="M18.1 10.4A6 6 0 1 1 10.4 18.1M8 7h1.2v4" />
    </>
  ),
  phone: (
    <>
      <Rect x={6} y={2.5} width={12} height={19} rx={2.5} />
      <Path d="M10.5 18.5h3" />
    </>
  ),
  wallet: (
    <>
      <Rect x={3} y={6} width={18} height={14} rx={2.5} />
      <Path d="M3 10h18M6 3.5h10M15 15h2.5" />
    </>
  ),
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 22, color, strokeWidth = 1.9 }: { name: IconName; size?: number; color: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </Svg>
  );
}
