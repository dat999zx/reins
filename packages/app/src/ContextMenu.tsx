import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { ActName } from './keys.js';
import type { Item } from './menus.js';
import type { Pt } from './surface.js';

// `at` is in the view's coordinates; the menu flips to stay inside its offset parent. `onClose(true)` asks the caller to refocus the opener.
export function ContextMenu({ items, at, onRun, onClose }: { items: Item[]; at: Pt; onRun: (act: ActName) => void; onClose: (refocus: boolean) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const buttons = () => [...el.current!.querySelectorAll<HTMLButtonElement>('button')];
  useLayoutEffect(() => {
    const m = el.current!, v = m.offsetParent as HTMLElement, w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = `${Math.max(0, at.x + w > v.clientWidth ? at.x - w : at.x)}px`;
    m.style.top = `${Math.max(0, at.y + h > v.clientHeight ? at.y - h : at.y)}px`;
    buttons()[0]?.focus();
  }, []);
  useEffect(() => {
    const away = (e: Event) => { if (!(e.target instanceof Node && el.current?.contains(e.target))) onClose(false); };
    const blur = () => onClose(false);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('wheel', away, true);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('wheel', away, true); window.removeEventListener('blur', blur); };
  }, []);

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation(); // the workspace's own keys (Escape clears the selection, Ctrl+Z undoes) must not run under an open menu
    const b = buttons(), i = b.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); onClose(true); }
    else if (e.key === 'Tab') onClose(true);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); b[(i + (e.key === 'ArrowDown' ? 1 : b.length - 1)) % b.length]?.focus(); }
  };

  return (
    <div ref={el} className="sx-menu" role="menu" style={{ left: at.x, top: at.y }} onKeyDown={key} onPointerMove={(e) => e.stopPropagation()}>
      {items.map((it, n) => it === '-'
        ? <hr key={n} role="separator" />
        : <button key={it.act} role="menuitem" onClick={() => { onRun(it.act); onClose(true); }}>{it.label}{it.hint && <kbd aria-hidden>{it.hint}</kbd>}</button>)}
    </div>
  );
}
