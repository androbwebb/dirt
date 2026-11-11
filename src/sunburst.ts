import { hierarchy, partition, type HierarchyRectangularNode } from 'd3-hierarchy';
import { arc as d3arc } from 'd3-shape';
import { interpolateRgb } from 'd3-interpolate';
import { easeCubicInOut } from 'd3-ease';
import type { TreeNode } from './api';

export const RINGS = 6;
const TAU = Math.PI * 2;
const DURATION = 620;
const SVGNS = 'http://www.w3.org/2000/svg';

export const PALETTE = ['#FF5A1F', '#2F5BFF', '#FFD60A', '#12B76A', '#FF4FA3', '#7A5CFF', '#00B3C7', '#E8263A', '#A3E635', '#FF9F1C'];

type HNode = HierarchyRectangularNode<TreeNode>;

interface Geo {
  x0: number;
  x1: number;
  d: number; // depth (fractional during transitions)
  o: number; // opacity
}

interface ArcItem {
  node: HNode;
  el: SVGPathElement;
  from: Geo;
  to: Geo;
  fromFill: string;
  toFill: string;
}

export type Transition = { kind: 'in'; from: { x0: number; x1: number; depth: number } } | { kind: 'out'; childPath: string } | null;

export interface SunburstEvents {
  hover(node: TreeNode | null): void;
  drill(node: TreeNode): void;
  up(): void;
  dragStart(node: TreeNode, e: PointerEvent): void;
  ask(node: TreeNode): void;
}

export class Sunburst {
  readonly el: HTMLDivElement;
  private svg: SVGSVGElement;
  private gArcs: SVGGElement;
  private gLabels: SVGGElement;
  private hole: SVGCircleElement;
  private items: ArcItem[] = [];
  private byEl = new Map<Element, HNode>();
  private fills = new Map<string, string>();
  private geo = new Map<string, Geo>();
  private size = 600;
  private raf = 0;
  private root: HNode | null = null;
  private hovered: string | null = null;
  private ro: ResizeObserver;

  constructor(private events: SunburstEvents) {
    this.el = document.createElement('div');
    this.el.className = 'sunburst';
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.innerHTML = `
      <defs>
        <pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="7" height="7" class="hatch-bg"/>
          <line x1="0" y1="0" x2="0" y2="7" class="hatch-line"/>
        </pattern>
      </defs>`;
    this.gArcs = document.createElementNS(SVGNS, 'g');
    this.gLabels = document.createElementNS(SVGNS, 'g');
    this.gLabels.setAttribute('class', 'labels');
    this.hole = document.createElementNS(SVGNS, 'circle');
    this.hole.setAttribute('class', 'hole');
    this.svg.append(this.gArcs, this.hole, this.gLabels);
    this.el.append(this.svg);
    this.bind();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
  }

  destroy() {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
  }

  // ---------- geometry ----------
  private get R() {
    return this.size / 2 - 6;
  }
  private get r0() {
    return this.R * 0.3;
  }
  private get ringW() {
    return (this.R - this.r0) / RINGS;
  }
  /** Radius of the boundary at fractional depth k. Depth 0 spans the hole. */
  private boundary(k: number) {
    if (k <= 0) return 0;
    if (k <= 1) return this.r0 * k;
    return this.r0 + (k - 1) * this.ringW;
  }

  private arcGen = d3arc<Geo>()
    .startAngle((g) => g.x0)
    .endAngle((g) => g.x1)
    .innerRadius((g) => this.boundary(g.d))
    .outerRadius((g) => Math.max(this.boundary(g.d), this.boundary(g.d + 1) - 1))
    .padAngle((g) => Math.min((g.x1 - g.x0) / 4, 0.003))
    .padRadius(() => this.R);

  private resize() {
    const box = this.el.getBoundingClientRect();
    const s = Math.max(240, Math.floor(Math.min(box.width, box.height)));
    if (s === this.size && this.svg.getAttribute('width')) return;
    this.size = s;
    this.svg.setAttribute('width', String(s));
    this.svg.setAttribute('height', String(s));
    this.svg.setAttribute('viewBox', `${-s / 2} ${-s / 2} ${s} ${s}`);
    this.hole.setAttribute('r', String(this.r0 - 1));
    for (const it of this.items) this.paint(it, 1);
    this.drawLabels();
  }

  /** Radius of the inner hole, exposed so the HTML center label can match it. */
  holeRadius() {
    return this.r0;
  }

  // ---------- colors ----------
  private colorFor(n: HNode): string {
    if (n.data.type === 'rest') return 'url(#hatch)';
    if (n.depth === 0) return getCss('--paper');
    let top = n;
    while (top.depth > 1 && top.parent) top = top.parent;
    const idx = top.parent ? top.parent.children!.indexOf(top) : 0;
    const base = PALETTE[idx % PALETTE.length];
    const t = Math.min((n.depth - 1) * 0.16, 0.7);
    return interpolateRgb(base, getCss('--paper'))(t);
  }

  // ---------- render ----------
  render(tree: TreeNode, transition: Transition) {
    cancelAnimationFrame(this.raf);
    const h = hierarchy(tree, (d) => d.children);
    h.each((n) => {
      (n as { value?: number }).value = n.data.size;
    });
    const root = partition<TreeNode>().size([TAU, 1])(h);
    this.root = root;

    // Map from the new layout back into the previous frame so arcs morph.
    let start: (g: Geo, n: HNode) => Geo;
    if (transition?.kind === 'in') {
      const { x0: a0, x1: a1, depth: cd } = transition.from;
      const k = (a1 - a0) / TAU;
      start = (g) => ({ x0: a0 + g.x0 * k, x1: a0 + g.x1 * k, d: g.d + cd, o: g.d + cd > RINGS ? 0 : 1 });
    } else if (transition?.kind === 'out') {
      const child = root.descendants().find((n) => n.data.path === transition.childPath);
      if (child) {
        // The previous focus (possibly several levels down) expands back out
        // from the center to its slot in the new layout.
        const b0 = child.x0;
        const k = TAU / Math.max(child.x1 - child.x0, 1e-9);
        const shift = child.depth;
        const clamp = (x: number) => Math.max(0, Math.min(TAU, (x - b0) * k));
        start = (g, n) => {
          const inside = n === child || isAncestor(child, n);
          return { x0: clamp(g.x0), x1: clamp(g.x1), d: Math.max(0, g.d - shift), o: inside ? 1 : 0 };
        };
      } else start = (g) => ({ ...g, o: 0 });
    } else {
      start = (g) => ({ ...g, x1: g.x0, o: 0 });
    }

    const nodes = root.descendants().filter((n) => n.depth <= RINGS && n.x1 - n.x0 > 0.0015);
    this.gArcs.replaceChildren();
    this.byEl.clear();
    const newFills = new Map<string, string>();
    const newGeo = new Map<string, Geo>();
    this.items = nodes.map((node) => {
      const el = document.createElementNS(SVGNS, 'path');
      el.setAttribute('class', `arc t-${node.data.type}${node.depth === 0 ? ' arc-root' : ''}`);
      this.gArcs.append(el);
      this.byEl.set(el, node);
      const to: Geo = { x0: node.x0, x1: node.x1, d: node.depth, o: node.depth === 0 ? 0 : 1 };
      const from = transition ? start(to, node) : to;
      const toFill = this.colorFor(node);
      const prevFill = this.fills.get(node.data.path);
      const fromFill = prevFill && !prevFill.startsWith('url') && !toFill.startsWith('url') ? prevFill : toFill;
      newFills.set(node.data.path, toFill);
      newGeo.set(node.data.path, to);
      return { node, el, from, to, fromFill, toFill };
    });
    this.fills = newFills;
    this.geo = newGeo;
    this.hovered = null;

    if (!transition && this.items.length) {
      // First paint: sweep in clockwise.
      for (const it of this.items) it.from = { ...it.to, x0: 0, x1: 0, o: 1 };
    }
    this.gLabels.replaceChildren();
    this.animate();
  }

  private animate() {
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / DURATION);
      const e = easeCubicInOut(t);
      for (const it of this.items) this.paint(it, e);
      if (t < 1) this.raf = requestAnimationFrame(step);
      else this.drawLabels();
    };
    this.raf = requestAnimationFrame(step);
  }

  private paint(it: ArcItem, e: number) {
    const lerp = (a: number, b: number) => a + (b - a) * e;
    const g: Geo = {
      x0: lerp(it.from.x0, it.to.x0),
      x1: lerp(it.from.x1, it.to.x1),
      d: lerp(it.from.d, it.to.d),
      o: lerp(it.from.o, it.to.o),
    };
    it.el.setAttribute('d', this.arcGen(g) || '');
    it.el.style.opacity = String(g.o);
    it.el.setAttribute('fill', e >= 1 || it.fromFill === it.toFill ? it.toFill : interpolateRgb(it.fromFill, it.toFill)(e));
  }

  private drawLabels() {
    this.gLabels.replaceChildren();
    for (const it of this.items) {
      const n = it.node;
      if (n.depth < 1 || n.depth > 2 || n.data.type === 'rest') continue;
      const mid = (n.x0 + n.x1) / 2;
      const rMid = (this.boundary(n.depth) + this.boundary(n.depth + 1)) / 2;
      const arcLen = (n.x1 - n.x0) * rMid;
      const fontPx = n.depth === 1 ? 12 : 10;
      const maxChars = Math.floor((arcLen - 10) / (fontPx * 0.62));
      if (maxChars < 4) continue;
      let label = n.data.name.toUpperCase();
      if (label.length > maxChars) label = label.slice(0, maxChars - 1) + '…';
      const deg = (mid * 180) / Math.PI;
      const flip = deg > 90 && deg < 270;
      const x = Math.sin(mid) * rMid;
      const y = -Math.cos(mid) * rMid;
      const t = document.createElementNS(SVGNS, 'text');
      t.textContent = label;
      t.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${(flip ? deg + 180 : deg).toFixed(1)})`);
      t.setAttribute('class', `label d${n.depth} ${isDark(it.toFill) ? 'on-dark' : ''}`);
      t.setAttribute('font-size', String(fontPx));
      this.gLabels.append(t);
    }
  }

  // ---------- interaction ----------
  /** Highlight a path (and its ancestry/descendants); null clears. */
  highlight(path: string | null) {
    if (path === this.hovered) return;
    this.hovered = path;
    this.svg.classList.toggle('has-hover', !!path);
    if (!path) {
      for (const it of this.items) it.el.classList.remove('lit');
      return;
    }
    for (const it of this.items) {
      const p = it.node.data.path;
      const lit = p === path || path.startsWith(p + '/') || p.startsWith(path + '/');
      it.el.classList.toggle('lit', lit && it.node.depth > 0);
    }
  }

  /** Where a given path sits in the current layout (for zoom-in origins). */
  geometryOf(path: string): { x0: number; x1: number; depth: number } | null {
    const g = this.geo.get(path);
    return g ? { x0: g.x0, x1: g.x1, depth: g.d } : null;
  }

  private bind() {
    let down: { node: HNode; x: number; y: number; id: number } | null = null;
    let dragged = false;

    this.svg.addEventListener('pointermove', (e) => {
      if (down && !dragged && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 && down.node.data.type !== 'rest') {
        dragged = true;
        this.events.dragStart(down.node.data, e);
        return;
      }
      const n = this.byEl.get(e.target as Element);
      const target = n && n.depth > 0 ? n : null;
      this.highlight(target?.data.path ?? null);
      this.events.hover(target?.data ?? null);
    });
    this.svg.addEventListener('pointerleave', () => {
      this.highlight(null);
      this.events.hover(null);
    });
    this.svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const n = this.byEl.get(e.target as Element);
      dragged = false;
      down = n && n.depth > 0 ? { node: n, x: e.clientX, y: e.clientY, id: e.pointerId } : null;
    });
    this.svg.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (dragged) return;
      if (e.target === this.hole) return this.events.up();
      if (d && d.node.depth > 0) {
        // Drilling into a deep ring targets that exact folder.
        if (d.node.data.type === 'dir' && d.node.data.hasKids) this.events.drill(d.node.data);
      }
    });
    window.addEventListener('pointerup', () => {
      down = null;
    });
    this.svg.addEventListener('contextmenu', (e) => {
      const n = this.byEl.get(e.target as Element);
      if (!n || n.depth === 0 || n.data.type === 'rest') return;
      e.preventDefault();
      this.events.ask(n.data);
    });
  }

  rootNode() {
    return this.root?.data ?? null;
  }
}

function isAncestor(anc: HNode, n: HNode) {
  for (let p = n.parent; p; p = p.parent) if (p === anc) return true;
  return false;
}

function getCss(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#f4f1ea';
}

function isDark(color: string) {
  const m = color.match(/\d+(\.\d+)?/g);
  let r: number, g: number, b: number;
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else if (m && m.length >= 3) {
    [r, g, b] = m.slice(0, 3).map(Number);
  } else return false;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 140;
}
