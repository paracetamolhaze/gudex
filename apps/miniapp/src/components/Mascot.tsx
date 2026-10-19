import { useTranslation } from 'react-i18next';
import { Button } from './ui';

// Маскот GUDEX. Картинки с прозрачным фоном — public/mascot/.
export type MascotPose = 'hello' | 'card' | 'pay' | 'success' | 'chill' | 'thinking' | 'sad';

// Natural sizes of the 720px-tall pictures: the width is reserved before the image loads.
const DIM: Record<MascotPose, [number, number]> = { hello: [550, 720], card: [532, 720], pay: [478, 720], success: [691, 720], chill: [569, 720],
  thinking: [449, 720], sad: [490, 720] };

// float — спокойно покачивается; pop — появляется с «пружинкой», потом покачивается; shake — мотает (ошибка).
type Motion = 'float' | 'pop' | 'shake' | 'none';

// size — пиксели или CSS-значение (например, var(--mascot-h)), если размер зависит от высоты экрана.
export function Mascot({ pose, size = 200, motion = 'float' }: { pose: MascotPose; size?: number | string; motion?: Motion }) {
  return (
    <div className="mascot-stage" style={{ height: size }}>
      <img
        key={`${pose}-${motion}`}
        className={`mascot ${motion}`}
        src={pose === 'thinking' ? '/mascot/thinking-v2.webp' : `/mascot/${pose}.webp`}
        width={DIM[pose][0]}
        height={DIM[pose][1]}
        decoding="async"
        alt=""
        draggable={false}
        style={{ height: size }}
      />
    </div>
  );
}

const CONFETTI_COLORS = ['#ffffff', '#c9d2e3', '#3b74f2', '#3daeec', '#8a93a6'];

// Праздничный экран: маскот прыгает, сверху сыплется конфетти.
export function Celebrate({ title, text, onClose }: { title: string; text?: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="fullscreen celebrate">
      <div className="confetti" aria-hidden>
        {Array.from({ length: 28 }, (_, i) => (
          <span
            key={i}
            style={
              {
                left: `${(i * 37) % 100}%`,
                background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
                animationDelay: `${(i % 7) * 0.12}s`,
                animationDuration: `${1.8 + (i % 5) * 0.3}s`,
                '--drift': `${((i % 9) - 4) * 14}px`,
                '--spin': `${180 + (i % 4) * 140}deg`,
              } as React.CSSProperties
            }
          />
        ))}
      </div>
      <div className="grow center-screen" style={{ minHeight: 0 }}>
        <Mascot pose="success" size={240} motion="pop" />
        <h1 className="title">{title}</h1>
        {text ? <p className="muted" style={{ margin: 0 }}>{text}</p> : null}
      </div>
      <div style={{ maxWidth: 488, width: '100%', margin: '0 auto' }}>
        <Button title={t('common.great')} onClick={onClose} />
      </div>
    </div>
  );
}
