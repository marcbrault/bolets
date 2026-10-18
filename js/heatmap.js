// Pinta una graella de valors com a imatge contínua (interpolació bilineal) retallada al contorn de Catalunya.

const R = 6378137;
export const mercX = lon => lon * Math.PI / 180 * R;
export const mercY = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

// ---------- Rampes de color ----------
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rampa = stops => stops.map(([v, h, a]) => [v, [...hex(h), a]]);

export const RAMPES = {
  index: {
    stops: rampa([[0, '#7a2a2a', 0.16], [12, '#b8452e', 0.38], [30, '#e08a35', 0.66], [50, '#e9c64a', 0.76], [68, '#93c159', 0.82], [84, '#3c9a4b', 0.88], [100, '#0f5a35', 0.92]]),
    min: 0, max: 100, unitat: '', etiquetes: ['molt baixa', 'baixa', 'moderada', 'alta', 'molt alta'],
  },
  pluja7: {
    stops: rampa([[0, '#efe9da', 0.25], [5, '#c6dbef', 0.55], [20, '#6baed6', 0.72], [50, '#2171b5', 0.85], [100, '#08306b', 0.92]]),
    min: 0, max: 100, unitat: ' mm',
  },
  temp7: {
    stops: rampa([[-5, '#3b4cc0', 0.8], [3, '#7b9ff9', 0.75], [10, '#c0d4f5', 0.7], [15, '#f2cbb7', 0.7], [20, '#ee8468', 0.78], [27, '#b40426', 0.85]]),
    min: -5, max: 27, unitat: ' °C',
  },
  elev: {
    stops: rampa([[0, '#5a9c5a', 0.7], [400, '#b5cf7a', 0.7], [900, '#e3d48c', 0.72], [1500, '#c19a63', 0.76], [2100, '#8f6b4f', 0.8], [2800, '#f4f1ec', 0.85]]),
    min: 0, max: 2800, unitat: ' m',
  },
  sol: {
    stops: rampa([[0, '#d9cfa8', 0.75], [0.5, '#b9b4ad', 0.55], [1, '#8a5a7a', 0.75]]),
    min: 0, max: 1, unitat: '', format: v => v < 0.25 ? 'calcari' : v > 0.75 ? 'silici' : 'mixt / ?',
  },
  habitat: {
    stops: rampa([[0, '#efe9da', 0.3], [0.1, '#e7d9a2', 0.55], [0.3, '#c7a75a', 0.72], [0.6, '#8a5a2b', 0.88]]),
    min: 0, max: 0.6, unitat: '', format: v => Math.round(v * 100) + '%',
  },
  bosc: {
    stops: rampa([[0, '#efe9da', 0.35], [0.4, '#a9c98a', 0.65], [0.75, '#4f8f4a', 0.8], [1, '#1d5531', 0.88]]),
    min: 0, max: 1, unitat: '', format: v => Math.round(v * 100) + '%',
  },
};

export function color(nomRampa, v) {
  const s = RAMPES[nomRampa].stops;
  if (v <= s[0][0]) return s[0][1];
  for (let k = 1; k < s.length; k++) {
    if (v <= s[k][0]) {
      const [v0, c0] = s[k - 1], [v1, c1] = s[k], f = (v - v0) / (v1 - v0);
      return c0.map((x, j) => x + (c1[j] - x) * f);
    }
  }
  return s[s.length - 1][1];
}
export const css = ([r, g, b, a = 1]) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

export function gradientCSS(nomRampa) {
  const { stops, min, max } = RAMPES[nomRampa];
  return `linear-gradient(90deg, ${stops.map(([v, c]) => `${css([...c.slice(0, 3), Math.min(1, c[3] + 0.15)])} ${((v - min) / (max - min) * 100).toFixed(1)}%`).join(', ')})`;
}

// ---------- Render ----------
export class Heatmap {
  constructor(grid, contorn) {
    this.g = grid;
    this.S = grid.km >= 10 ? 16 : grid.km >= 5 ? 8 : 2; // píxels per cel·la
    this.canvas = document.createElement('canvas');
    this.canvas.width = grid.nx * this.S;
    this.canvas.height = grid.ny * this.S;
    this.ctx = this.canvas.getContext('2d');
    // camí del contorn en coordenades de canvas
    const { x0, y1, step } = grid, S = this.S;
    this.cami = new Path2D();
    const polys = contorn.type === 'Polygon' ? [contorn.coordinates] : contorn.coordinates;
    for (const poly of polys) for (const ring of poly) {
      ring.forEach(([lon, lat], k) => {
        const px = (mercX(lon) - x0) / step * S, py = (y1 - mercY(lat)) / step * S;
        k ? this.cami.lineTo(px, py) : this.cami.moveTo(px, py);
      });
      this.cami.closePath();
    }
  }

  get coordinates() {
    const g = this.g;
    return [[g.west, g.north], [g.east, g.north], [g.east, g.south], [g.west, g.south]];
  }

  pinta(valors, nomRampa) {
    const { nx, ny, cells } = this.g;
    // graella amb buits (NaN) fora de Catalunya
    const V = new Float32Array(nx * ny).fill(NaN);
    cells.forEach(([c, r], i) => { V[r * nx + c] = valors[i]; });
    return this.pintaGraella(V, nomRampa);
  }

  /** Pinta una graella completa (nx × ny, NaN = buit). */
  pintaGraella(V, nomRampa, url = true) {
    const { nx, ny } = this.g, S = this.S;
    // omple 2 anells de vora amb la mitjana dels veïns perquè la interpolació arribi al contorn
    for (let pass = 0; pass < 2; pass++) {
      const W = V.slice();
      for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
        if (!isNaN(V[r * nx + c])) continue;
        let s = 0, n = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= ny || cc >= nx) continue;
          const v = V[rr * nx + cc]; if (!isNaN(v)) { s += v; n++; }
        }
        if (n) W[r * nx + c] = s / n;
      }
      V.set(W);
    }
    // LUT de colors (256 nivells) per velocitat
    const { min, max } = RAMPES[nomRampa];
    const lut = new Uint8ClampedArray(256 * 4);
    for (let k = 0; k < 256; k++) {
      const col = color(nomRampa, min + (max - min) * k / 255);
      lut.set([col[0], col[1], col[2], Math.round(col[3] * 255)], k * 4);
    }
    const W = this.canvas.width, H = this.canvas.height;
    const img = this.ctx.createImageData(W, H), px = img.data;
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / S - 0.5, r0 = Math.floor(v), fy = v - r0;
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / S - 0.5, c0 = Math.floor(u), fx = u - c0;
        let s = 0, w = 0;
        const add = (r, c, wt) => {
          if (r < 0 || c < 0 || r >= ny || c >= nx || wt === 0) return;
          const val = V[r * nx + c]; if (!isNaN(val)) { s += val * wt; w += wt; }
        };
        add(r0, c0, (1 - fx) * (1 - fy)); add(r0, c0 + 1, fx * (1 - fy));
        add(r0 + 1, c0, (1 - fx) * fy); add(r0 + 1, c0 + 1, fx * fy);
        if (!w) continue;
        const k = Math.max(0, Math.min(255, Math.round(((s / w) - min) / (max - min) * 255))) * 4;
        const o = (y * W + x) * 4;
        px[o] = lut[k]; px[o + 1] = lut[k + 1]; px[o + 2] = lut[k + 2]; px[o + 3] = lut[k + 3];
      }
    }
    this.ctx.clearRect(0, 0, W, H);
    this.ctx.putImageData(img, 0, 0);
    this.ctx.globalCompositeOperation = 'destination-in';
    this.ctx.fill(this.cami, 'evenodd');
    this.ctx.globalCompositeOperation = 'source-over';
    return url ? this.canvas.toDataURL('image/png') : null;
  }

  /** Cel·la sota un punt (lon, lat), o -1. */
  cellaA(lon, lat) {
    const g = this.g;
    if (!this._idx) this._idx = new Map(g.cells.map((c, i) => [c[0] + ',' + c[1], i]));
    const c = Math.floor((mercX(lon) - g.x0) / g.step), r = Math.floor((g.y1 - mercY(lat)) / g.step);
    return this._idx.get(c + ',' + r) ?? -1;
  }

  /** Polígon (lon/lat) de la cel·la i. */
  quadrat(i) {
    const g = this.g, [c, r] = g.cells[i];
    const lon = x => x / R * 180 / Math.PI, lat = y => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
    const xa = g.x0 + c * g.step, xb = xa + g.step, ya = g.y1 - r * g.step, yb = ya - g.step;
    return [[lon(xa), lat(ya)], [lon(xb), lat(ya)], [lon(xb), lat(yb)], [lon(xa), lat(yb)], [lon(xa), lat(ya)]];
  }
}
