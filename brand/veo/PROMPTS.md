# Анимации маскота GUDEX — промпты для Veo 3 / Veo 3.1

**Как генерировать.** Image-to-video, кадр — PNG из этой папки (маскот на зелёном фоне). Если инструмент умеет «последний кадр», ставь тот же PNG — получится бесшовная петля. Формат 16:9, 4–6 секунд, без звука.

**Что прислать:** MP4 как есть. Я вырежу зелёный фон и сделаю:
- прозрачные анимации для Mini App;
- анимацию 640×360 для описания бота в @BotFather.

**Общий хвост промпта** (добавлять к каждому):

> Static locked-off camera, the character stays centered and the same size, no camera movement. Solid flat chroma key green background, evenly lit, no shadows, no other objects. The animation ends in exactly the same pose as it starts, so it can loop seamlessly.

**Negative prompt:** camera movement, zoom, pan, text, letters, extra characters, background change, shadows on background, lighting change

| Файл | Поза | Промпт (начало) |
|---|---|---|
| `hello.png` | HELLO | A cute 3D cartoon mascot — a white soft-toy robot with cat ears, a glossy black face screen with two glowing smiling eyes, a black zip hoodie with a white letter G — happily waves its raised hand hello two times, the body gently bobs, then the hand returns to the starting pose. |
| `card.png` | CARD | The same mascot proudly shows the black GUDEX card to the viewer, tilts it slightly so a light gleam slides across the card, the glowing eyes smile, then returns the card to the starting position. |
| `pay.png` | PAY | The same mascot taps the phone screen twice with a finger, a small happy nod, the glowing eyes smile, then returns to the starting pose. |
| `success.png` | SUCCESS | The same mascot jumps up with both fists raised in joy, metallic confetti flutters around, lands softly and returns to the starting pose. |
| `chill.png` | CHILL | The same mascot sits and gently nods its head to music in the headphones, swaying slightly, the glowing eyes stay closed and calm. |
| `thinking.png` | THINKING | The same mascot taps its chin thoughtfully, the glowing eyes look left and right, then back to the starting pose. |
| `sad.png` | SAD | The same mascot sighs, its shoulders drop slightly and it slowly shakes its head, the glowing eyes droop, then returns to the starting pose. |
| `travel.png` | TRAVEL | The same mascot in sunglasses walks in place rolling a black suitcase, confident and relaxed, returning to the starting pose. |

Ориентир по цене на Vertex AI (Veo 3.1 Fast, 720p, без звука): $0.08 за секунду, то есть 8 роликов по 4 с ≈ $2.6.
