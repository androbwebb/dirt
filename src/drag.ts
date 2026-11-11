import type { TreeNode } from './api';
import { bytes, esc } from './format';

/**
 * Pointer-driven drag with a brutalist "ghost" card. Works for both SVG arcs
 * and HTML rows (native HTML5 drag doesn't support SVG elements well).
 */
export function startDrag(node: TreeNode, e: PointerEvent, dropTarget: () => HTMLElement | null, onDrop: (node: TreeNode) => void) {
  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.innerHTML = `<span class="ghost-name">${esc(node.name)}</span><span class="ghost-size">${bytes(node.size)}</span>`;
  document.body.append(ghost);
  document.body.classList.add('dragging');

  const move = (ev: PointerEvent) => {
    ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px) rotate(-3deg)`;
    const t = dropTarget();
    if (t) t.classList.toggle('drop-hot', hit(t, ev));
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.classList.remove('dragging');
    ghost.remove();
    const t = dropTarget();
    if (t) {
      t.classList.remove('drop-hot');
      if (hit(t, ev)) onDrop(node);
    }
  };
  move(e);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function hit(el: HTMLElement, ev: PointerEvent) {
  const r = el.getBoundingClientRect();
  return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
}
