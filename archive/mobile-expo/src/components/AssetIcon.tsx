import Svg, { Circle, Ellipse, Rect, Text as SvgText } from 'react-native-svg';
import type { WalletAsset } from '@gudex/shared';

// Упрощённые значки стейблкоинов в фирменных цветах эмитентов.
export function AssetIcon({ asset, size = 40 }: { asset: WalletAsset; size?: number }) {
  if (asset === 'USDT') {
    return (
      <Svg width={size} height={size} viewBox="0 0 40 40">
        <Circle cx={20} cy={20} r={20} fill="#26A17B" />
        <Rect x={11} y={10.5} width={18} height={4.4} rx={0.6} fill="#FFFFFF" />
        <Rect x={17.6} y={10.5} width={4.8} height={20} rx={0.6} fill="#FFFFFF" />
        <Ellipse cx={20} cy={20.6} rx={8.6} ry={2.7} fill="none" stroke="#FFFFFF" strokeWidth={2} />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <Circle cx={20} cy={20} r={20} fill="#2775CA" />
      <Circle cx={20} cy={20} r={12.5} fill="none" stroke="#FFFFFF" strokeWidth={2} />
      <SvgText x={20} y={25.5} fontSize={15} fontWeight="bold" fill="#FFFFFF" textAnchor="middle">
        $
      </SvgText>
    </Svg>
  );
}
