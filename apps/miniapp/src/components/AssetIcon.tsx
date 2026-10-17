import type { WalletAsset } from '@gudex/shared';

// Упрощённые значки стейблкоинов в фирменных цветах эмитентов.
export function AssetIcon({ asset, size = 40 }: { asset: WalletAsset; size?: number }) {
  if (asset === 'USDT') {
    return (
      <svg width={size} height={size} viewBox="0 0 40 40">
        <circle cx={20} cy={20} r={20} fill="#26A17B" />
        <rect x={11} y={10.5} width={18} height={4.4} rx={0.6} fill="#FFFFFF" />
        <rect x={17.6} y={10.5} width={4.8} height={20} rx={0.6} fill="#FFFFFF" />
        <ellipse cx={20} cy={20.6} rx={8.6} ry={2.7} fill="none" stroke="#FFFFFF" strokeWidth={2} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 40 40">
      <circle cx={20} cy={20} r={20} fill="#2775CA" />
      <circle cx={20} cy={20} r={12.5} fill="none" stroke="#FFFFFF" strokeWidth={2} />
      <text x={20} y={25.5} fontSize={15} fontWeight="bold" fill="#FFFFFF" textAnchor="middle">
        $
      </text>
    </svg>
  );
}
