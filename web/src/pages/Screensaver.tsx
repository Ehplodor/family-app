import { useEffect, useRef } from 'react';

/**
 * Fonds de veille du mode chevet, dessinés sur un canvas (aucune image, aucun fichier).
 * Animation lente (environ 12 images/s) pour économiser la batterie ; le contenu bouge
 * sans cesse, ce qui évite aussi de marquer l'écran.
 */
/** `black` : écran entièrement noir (pixels éteints sur OLED), l'heure n'apparaît qu'au toucher ou au mouvement. */
export type SaverKind = 'none' | 'black' | 'pipes' | 'aquarium';
export const SAVER_LABEL: Record<SaverKind, string> = { none: 'Horloge pâle', black: 'Noir complet', pipes: 'Tuyaux', aquarium: 'Aquarium' };

type Painter = { step: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void };

/* ------------------------------------------------------------------ Tuyaux */

function pipes(): Painter {
  const CELL = 26;
  const DIRS = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  type Pipe = { x: number; y: number; d: number; hue: number; left: number };
  let list: Pipe[] = [];
  let drawn = 0;
  const spawn = (w: number, h: number): Pipe => ({
    x: Math.floor(Math.random() * (w / CELL)),
    y: Math.floor(Math.random() * (h / CELL)),
    d: Math.floor(Math.random() * 4),
    hue: Math.floor(Math.random() * 360),
    left: 40 + Math.floor(Math.random() * 80),
  });
  return {
    step(ctx, w, h) {
      if (drawn === 0) ctx.clearRect(0, 0, w, h);
      while (list.length < 3) list.push(spawn(w, h));
      for (const p of list) {
        if (Math.random() < 0.22) p.d = (p.d + (Math.random() < 0.5 ? 1 : 3)) % 4;
        let [dx, dy] = DIRS[p.d];
        // Rebond sur les bords
        if (p.x + dx < 0 || p.y + dy < 0 || (p.x + dx) * CELL > w || (p.y + dy) * CELL > h) {
          p.d = (p.d + 2) % 4;
          [dx, dy] = DIRS[p.d];
        }
        const x0 = p.x * CELL + CELL / 2;
        const y0 = p.y * CELL + CELL / 2;
        p.x += dx;
        p.y += dy;
        const grad = ctx.createLinearGradient(x0 - dy * 6, y0 - dx * 6, x0 + dy * 6, y0 + dx * 6);
        grad.addColorStop(0, `hsl(${p.hue} 60% 22%)`);
        grad.addColorStop(0.5, `hsl(${p.hue} 70% 55%)`);
        grad.addColorStop(1, `hsl(${p.hue} 60% 22%)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 12;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(p.x * CELL + CELL / 2, p.y * CELL + CELL / 2);
        ctx.stroke();
        p.left--;
        drawn++;
      }
      list = list.filter((p) => p.left > 0);
      if (drawn > 900) drawn = 0; // écran plein : on recommence
    },
  };
}

/* ------------------------------------------------------------------ Aquarium */

function aquarium(): Painter {
  type Fish = { x: number; y: number; v: number; size: number; hue: number; phase: number };
  type Bubble = { x: number; y: number; r: number };
  let fish: Fish[] = [];
  let bubbles: Bubble[] = [];
  return {
    step(ctx, w, h, t) {
      if (!fish.length) {
        fish = Array.from({ length: 7 }, () => ({
          x: Math.random() * w,
          y: h * (0.15 + Math.random() * 0.65),
          v: (0.6 + Math.random() * 1.4) * (Math.random() < 0.5 ? -1 : 1),
          size: 14 + Math.random() * 22,
          hue: [20, 35, 50, 190, 330, 280][Math.floor(Math.random() * 6)],
          phase: Math.random() * 6,
        }));
      }
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#04131f');
      bg.addColorStop(1, '#020a10');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      // Sable et algues
      ctx.fillStyle = '#1c1710';
      ctx.fillRect(0, h - 26, w, 26);
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      for (let i = 0; i < 9; i++) {
        const x0 = ((i + 0.5) / 9) * w;
        ctx.strokeStyle = `hsl(${120 + i * 7} 45% ${16 + (i % 3) * 4}%)`;
        ctx.beginPath();
        ctx.moveTo(x0, h - 20);
        for (let k = 1; k <= 8; k++) ctx.lineTo(x0 + Math.sin(t / 1400 + k / 2 + i) * k * 2.2, h - 20 - k * (12 + (i % 4) * 5));
        ctx.stroke();
      }
      // Poissons
      for (const f of fish) {
        f.x += f.v;
        const y = f.y + Math.sin(t / 900 + f.phase) * 6;
        if (f.x > w + 60) f.x = -60;
        if (f.x < -60) f.x = w + 60;
        const dir = Math.sign(f.v);
        const s = f.size;
        const wag = Math.sin(t / 160 + f.phase) * s * 0.18;
        ctx.fillStyle = `hsl(${f.hue} 75% 50%)`;
        ctx.beginPath();
        ctx.ellipse(f.x, y, s, s * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(f.x - dir * s * 0.8, y);
        ctx.lineTo(f.x - dir * s * 1.6, y - s * 0.5 + wag);
        ctx.lineTo(f.x - dir * s * 1.6, y + s * 0.5 + wag);
        ctx.fill();
        ctx.fillStyle = '#0a0a0a';
        ctx.beginPath();
        ctx.arc(f.x + dir * s * 0.55, y - s * 0.1, s * 0.09, 0, Math.PI * 2);
        ctx.fill();
      }
      // Bulles
      if (Math.random() < 0.15) bubbles.push({ x: w * (0.2 + Math.random() * 0.6), y: h - 26, r: 2 + Math.random() * 4 });
      ctx.strokeStyle = 'rgba(180, 220, 255, 0.6)';
      ctx.lineWidth = 1.2;
      for (const b of bubbles) {
        b.y -= 1.2 + b.r * 0.3;
        b.x += Math.sin((b.y + b.r * 50) / 30) * 0.4;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      bubbles = bubbles.filter((b) => b.y > -10);
    },
  };
}

export function Screensaver({ kind }: { kind: SaverKind }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || kind === 'none' || kind === 'black') return;
    const painter = kind === 'pipes' ? pipes() : aquarium();
    const resize = () => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    };
    resize();
    window.addEventListener('resize', resize);
    const timer = setInterval(() => painter.step(ctx, canvas.width, canvas.height, performance.now()), 80);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', resize);
    };
  }, [kind]);
  if (kind === 'none' || kind === 'black') return null;
  return <canvas ref={ref} className="saver" aria-hidden="true" />;
}
