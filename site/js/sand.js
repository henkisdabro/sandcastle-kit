// Sand: the night beach behind the page. A plain script, not a module, so the
// page also works opened straight from disk.
//
// - The castle is built from the base up, held, blown away top first and built
//   again, on a canvas of its own at the screen's full resolution.
// - A field of grains drifts on gusting wind, four layers deep, each moving
//   with the scroll at its own rate; a gust front sweeps across now and then.
// - Dunes lit by the moon sit under the status window and creep with the wind.
// - The pointer blows grains aside; puff(x, y) kicks some up.
(function () {
  'use strict';

  const NIGHT = [14, 17, 22];
  const DEEP = [112, 92, 66];
  const DRY = [205, 184, 148];
  const MOON = [232, 214, 180];
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const css = (c, s = 1) => `rgb(${Math.min(255, c[0] * s) | 0},${Math.min(255, c[1] * s) | 0},${Math.min(255, c[2] * s) | 0})`;

  const GLINT = css(MOON, 1.08);
  const LAYERS = [
    { depth: 0.08, size: 1.1, rgb: [128, 106, 80], alpha: 0.9, wind: 7, share: 0.38 },
    { depth: 0.22, size: 1.5, rgb: [176, 152, 116], alpha: 0.85, wind: 13, share: 0.32 },
    { depth: 0.45, size: 2, rgb: DRY, alpha: 0.8, wind: 22, share: 0.21 },
    { depth: 0.8, size: 2.7, rgb: MOON, alpha: 0.75, wind: 36, share: 0.09 },
  ];
  // Far to near: the far ones drift slowest.
  // Far dunes are paler and fade into the night; near ones are warmer.
  const DUNES = [
    { height: 0.2, body: mix(NIGHT, DEEP, 0.2), lit: mix(NIGHT, DRY, 0.3), drift: 1.6, seed: 11, ripples: 0 },
    { height: 0.14, body: mix(NIGHT, DEEP, 0.36), lit: mix(NIGHT, DRY, 0.46), drift: 3.2, seed: 23, ripples: 0 },
    { height: 0.09, body: mix(NIGHT, DEEP, 0.54), lit: mix(NIGHT, DRY, 0.64), drift: 5.5, seed: 37, ripples: 5 },
  ];
  // The moon is up and to the right: the slopes that face it catch its light.
  const LIGHT = [0.55, 0.835];

  function rand(seed) {
    let s = seed;
    return () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }
  const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

  function sand({ field: canvas, dunes: duneCanvas, castle, castleCanvas, reduced }) {
    const ctx = canvas.getContext('2d');
    const dctx = duneCanvas ? duneCanvas.getContext('2d') : null;
    const cctx = castleCanvas ? castleCanvas.getContext('2d') : null;
    // Full resolution, up to 3x: a phone's screen is where grains look coarse first.
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const coarse = matchMedia('(pointer: coarse)').matches;
    let W = 0;
    let H = 0;
    let grains = [];
    let puffs = [];
    let dunes = [];
    let cast = null;
    let fieldAlpha = 0;
    let raf = 0;
    let last = 0;
    let clock = 0;
    let castleBox = null;
    const pointer = { x: -1e4, y: -1e4, vx: 0, vy: 0, at: -1e4 };

    function size() {
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const b = castle.getBoundingClientRect();
      castleBox = { w: b.width, h: b.height };
      placeCastleCanvas();
      buildDunes();
    }

    // ------------------------------------------------------------ the field

    function makeField() {
      const r = rand(7);
      const count = Math.round(Math.min(coarse ? 180 : 650, Math.max(120, (W * H) / 2500)));
      grains = [];
      for (const L of LAYERS) {
        const n = Math.round(count * L.share);
        for (let i = 0; i < n; i++) {
          // A few specks of shell, and a few grains that catch the moon now and then.
          const speck = r() < 0.03;
          const glint = !speck && L.depth > 0.2 && r() < 0.16;
          grains.push({
            L,
            x: r() * W,
            y: r() * H * 1.6,
            vx: 0,
            vy: 0,
            phase: r() * Math.PI * 2,
            speck,
            glint,
            rate: 0.35 + r() * 0.5,
            size: L.size * (0.7 + r() * 0.6),
            fill: css(L.rgb, 0.82 + r() * 0.3),
          });
        }
      }
    }

    // The wind: a slow swell, and every eleven seconds a gust front that
    // crosses the screen in two, lifting what it passes.
    function wind(x) {
      const swell = 0.75 + 0.3 * Math.sin(clock * 0.13) + 0.2 * Math.sin(clock * 0.41 + 1.3);
      const cycle = clock % 11;
      if (cycle > 2.4) return swell;
      const front = (cycle / 2.4) * (W + 700) - 350;
      const d = (x - front) / 190;
      return swell * (1 + 4.2 * Math.exp(-d * d));
    }

    function drawField(dt) {
      const sy = window.scrollY;
      const span = H * 1.6;
      const recent = clock - pointer.at < 0.25;
      for (const p of grains) {
        const L = p.L;
        const w = wind(p.x);
        if (dt) {
          p.x += (L.wind * w + p.vx) * dt;
          p.y += p.vy * dt;
          const drag = Math.exp(-dt * 2.2);
          p.vx *= drag;
          p.vy *= drag;
        }
        if (p.x > W + 12) p.x -= W + 24;
        if (p.x < -12) p.x += W + 24;
        let y = (p.y - sy * L.depth) % span;
        if (y < 0) y += span;
        y += Math.sin(clock * 0.7 + p.phase) * 3 - H * 0.3;
        if (y < -10 || y > H + 10) continue;

        // The pointer is a breath of wind: grains near it are pushed along and away.
        if (recent && dt) {
          const dx = p.x - pointer.x;
          const dy = y - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 150 * 150 && d2 > 1) {
            const d = Math.sqrt(d2);
            const f = (1 - d / 150) ** 2 * (0.6 + L.depth);
            p.vx += ((dx / d) * 520 + pointer.vx * 0.5) * f * dt * 4;
            p.vy += ((dy / d) * 520 + pointer.vy * 0.5) * f * dt * 4;
          }
        }

        const speed = L.wind * w + p.vx;
        // Sand hangs low: grains thin out towards the top of the screen.
        let a = L.alpha * fieldAlpha * (0.6 + 0.4 * Math.min(1, Math.max(0, y / H)));
        if (p.speck) a *= 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(clock * 1.7 + p.phase * 3));
        // A glint: a short, sharp flash, then dark for a few seconds.
        const flash = p.glint ? Math.max(0, Math.sin(clock * p.rate + p.phase)) ** 12 : 0;
        if (flash > 0.02) {
          ctx.fillStyle = GLINT;
          // A soft halo under the cross, so a glint reads against the night from across the page.
          ctx.globalAlpha = 0.16 * flash * fieldAlpha;
          ctx.beginPath();
          ctx.arc(p.x, y, p.size * (2 + flash * 3), 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = Math.min(1, 0.45 + flash) * fieldAlpha;
          const g = p.size * (1.6 + flash * 2.6);
          ctx.fillRect(p.x - g, y - 0.5, g * 2, 1);
          ctx.fillRect(p.x - 0.5, y - g, 1, g * 2);
        }
        ctx.globalAlpha = a;
        if (p.speck) {
          // A speck of shell: the logo's +, a hairline cross.
          const s = 2 + L.depth * 2;
          ctx.fillStyle = p.fill;
          ctx.fillRect(p.x - s, y - 0.5, s * 2, 1);
          ctx.fillRect(p.x - 0.5, y - s, 1, s * 2);
        } else if (Math.abs(speed) > 55) {
          // Fast grains blur into a short streak along the wind.
          const tail = Math.min(14, Math.abs(speed) * 0.035);
          ctx.globalAlpha = a * 0.7;
          ctx.strokeStyle = p.fill;
          ctx.lineWidth = p.size;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(p.x - Math.sign(speed) * tail, y - (p.vy * tail) / Math.max(1, Math.abs(speed)));
          ctx.lineTo(p.x, y);
          ctx.stroke();
        } else {
          ctx.fillStyle = p.fill;
          ctx.beginPath();
          ctx.arc(p.x, y, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // ------------------------------------------------------------ puffs

    function puff(x, y, n = 36, spread = 1) {
      if (reduced.matches) return;
      const r = Math.random;
      for (let i = 0; i < n; i++) {
        const angle = -Math.PI / 2 + (r() - 0.5) * Math.PI * 1.3 * spread;
        const v = 60 + r() * 190;
        const c = r() < 0.5 ? DRY : r() < 0.6 ? MOON : DEEP;
        puffs.push({
          x, y: y + window.scrollY,
          vx: Math.cos(angle) * v, vy: Math.sin(angle) * v,
          life: 0, max: 0.9 + r() * 0.9,
          size: 1 + r() * 1.6,
          fill: css(c, 0.85 + r() * 0.25),
        });
      }
      wake();
    }

    function drawPuffs(dt) {
      const sy = window.scrollY;
      puffs = puffs.filter((p) => (p.life += dt) < p.max);
      for (const p of puffs) {
        p.vy += 260 * dt;
        p.vx += 18 * dt;
        const drag = Math.exp(-dt * 1.6);
        p.vx *= drag;
        p.vy *= drag;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const u = p.life / p.max;
        ctx.globalAlpha = (1 - u) ** 1.6 * 0.9;
        ctx.fillStyle = p.fill;
        ctx.beginPath();
        ctx.arc(p.x, p.y - sy, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ------------------------------------------------------------ the castle
    // Built from the base up, held, blown away and built again, for as long
    // as it is on screen. It has a canvas of its own beside the castle, at the
    // screen's full resolution, that scrolls with the page.

    // When each row starts to pour, in ms: the base with its door, the course
    // above it, the two rows of wall, then the merlons. Each row settles
    // before the next begins, so the castle is seen going up.
    const ROW_AT = { 5: 0, 4: 1450, 3: 2900, 2: 4250, 1: 5600 };
    const HOLD = 16000;
    const GAP = 1200;
    // How far the castle's canvas reaches past it: grains blow in from the
    // left and above, and are carried off to the right.
    const PAD = { l: 280, t: 260, r: 540, b: 60 };
    const snap = (v) => Math.round(v * dpr) / dpr;
    let castleVisible = true;

    function placeCastleCanvas() {
      if (!castleCanvas) return;
      const w = castleBox.w + PAD.l + PAD.r;
      const h = castleBox.h + PAD.t + PAD.b;
      // From the boxes, not offsetLeft: an SVG element has no offset properties.
      const parent = (castleCanvas.offsetParent || castleCanvas.parentElement).getBoundingClientRect();
      const b = castle.getBoundingClientRect();
      Object.assign(castleCanvas.style, {
        left: `${b.left - parent.left - PAD.l}px`,
        top: `${b.top - parent.top - PAD.t}px`,
        width: `${w}px`,
        height: `${h}px`,
      });
      castleCanvas.width = Math.round(w * dpr);
      castleCanvas.height = Math.round(h * dpr);
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function makeCastle() {
      const rects = [...castle.querySelectorAll('rect')];
      const px = castleBox.w / 5;
      const cells = [];
      rects.forEach((rect, ri) => {
        const x0 = +rect.getAttribute('x');
        const y0 = +rect.getAttribute('y');
        const w = +rect.getAttribute('width');
        const h = +rect.getAttribute('height');
        const rgb = y0 === 1 ? MOON : y0 >= 4 ? DEEP : DRY;
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) cells.push({ x, y, rgb, ri });
      });
      const r = rand(3);
      // Fine grains: about fourteen to a cell's width.
      const grain = Math.max(1.1, px / 14);
      const per = Math.round((px / grain) ** 2 * 0.75);
      const k = Math.ceil(Math.sqrt(per));
      const list = [];
      const order = {};
      const release = rects.map(() => Infinity);
      for (const c of cells.sort(() => r() - 0.5)) {
        const nth = (order[c.y] = (order[c.y] ?? -1) + 1);
        for (let g = 0; g < per; g++) {
          // In the castle canvas's own coordinates.
          const tx = PAD.l + (c.x + ((g % k) + r()) / k) * px;
          const ty = PAD.t + (c.y - 1 + Math.min(0.999, (Math.floor(g / k) + r()) / k)) * px;
          // Blown in from close by, the left and above, on a curve the wind bends.
          const sx = tx - 70 - r() * 170;
          const sy = ty - 90 - r() * 150;
          const e0 = (c.y - 1) * 260 + r() * 900;
          release[c.ri] = Math.min(release[c.ri], e0);
          list.push({
            tx, ty, sx, sy,
            cx: sx + (tx - sx) * 0.6,
            cy: Math.min(sy, ty) - 20 - r() * 60,
            t0: ROW_AT[c.y] + nth * 80 + r() * 300,
            dur: 600 + r() * 350,
            // Blown away again: the top first, carried right on the wind.
            e0,
            edur: 1400 + r() * 1000,
            ex: 140 + r() * 320,
            lift: 20 + r() * 70,
            fill: css(c.rgb, 0.8 + r() * 0.32),
            size: grain * (0.75 + r() * 0.5),
            ri: c.ri,
          });
        }
      }
      return { rects, list, release, phase: 'hold', t: 0, first: true, landed: false, pending: [], solid: [], gone: [], dirty: false };
    }

    function startBuild(C) {
      C.phase = 'build';
      C.t = 0;
      C.landed = false;
      C.pending = C.rects.map(() => 0);
      C.solid = C.rects.map(() => -1);
      for (const g of C.list) {
        g.down = false;
        C.pending[g.ri]++;
      }
      for (const rect of C.rects) rect.style.opacity = '0';
    }

    // Each part stays solid until its own sand starts to go.
    function startErode(C) {
      C.phase = 'erode';
      C.t = 0;
      C.gone = C.rects.map(() => -1);
    }

    function grainAt(g, x, y, a) {
      cctx.globalAlpha = a;
      cctx.fillStyle = g.fill;
      cctx.fillRect(x - g.size / 2, y - g.size / 2, g.size, g.size);
    }

    function drawCastle(dt) {
      const C = cast;
      // The cycle waits while the castle is off screen, and nothing is drawn.
      if (!castleVisible) return;
      C.t += dt * 1000;
      if (C.phase === 'hold' || C.phase === 'gap') {
        if (C.dirty) {
          cctx.clearRect(0, 0, castleCanvas.width, castleCanvas.height);
          C.dirty = false;
        }
        if (C.phase === 'hold' && C.t > HOLD) startErode(C);
        else if (C.phase === 'gap' && C.t > GAP) startBuild(C);
        return;
      }
      cctx.clearRect(0, 0, castleCanvas.width, castleCanvas.height);
      C.dirty = true;

      if (C.phase === 'build') {
        let flying = 0;
        for (const g of C.list) {
          if (C.t < g.t0) {
            flying++;
            continue;
          }
          const u = Math.min(1, (C.t - g.t0) / g.dur);
          if (u < 1) flying++;
          else if (!g.down) {
            g.down = true;
            // A part turns solid once all its sand is in.
            if (--C.pending[g.ri] === 0) {
              C.solid[g.ri] = C.t;
              C.rects[g.ri].style.opacity = '1';
            }
          }
          const fade = C.solid[g.ri] >= 0 ? 1 - (C.t - C.solid[g.ri]) / 320 : 1;
          if (fade <= 0) continue;
          if (u >= 1) {
            // Landed grains sit on whole device pixels; moving ones do not, or they would judder.
            grainAt(g, snap(g.tx), snap(g.ty), fade);
            continue;
          }
          const e = easeInOut(u);
          const m = 1 - e;
          const x = m * m * g.sx + 2 * m * e * g.cx + e * e * g.tx;
          const y = m * m * g.sy + 2 * m * e * g.cy + e * e * g.ty;
          grainAt(g, x, y, Math.min(1, u * 4) * fade);
        }
        if (!flying && !C.landed) {
          C.landed = true;
          // It stands: a puff of dust at its foot.
          const b = castle.getBoundingClientRect();
          puff(b.left + b.width * 0.12, b.bottom, 22, 0.9);
          puff(b.left + b.width * 0.88, b.bottom, 22, 0.9);
          C.first = false;
        }
        if (C.landed && C.t > Math.max(...C.solid) + 340) {
          C.phase = 'hold';
          C.t = 0;
        }
      } else {
        C.rects.forEach((rect, ri) => {
          if (C.gone[ri] < 0 && C.t >= C.release[ri]) {
            C.gone[ri] = C.t;
            rect.style.opacity = '0';
          }
        });
        let left = 0;
        for (const g of C.list) {
          const goneAt = C.gone[g.ri];
          if (goneAt < 0) {
            left++;
            continue;
          }
          const u = Math.max(0, (C.t - g.e0) / g.edur);
          if (u >= 1) continue;
          left++;
          // The part turns to sand as its solid fades, then the sand thins out on the wind.
          const a = Math.min(1, (C.t - goneAt) / 200) * (1 - u) ** 1.3;
          if (u === 0) grainAt(g, snap(g.tx), snap(g.ty), a);
          else grainAt(g, g.tx + g.ex * u * u, g.ty - g.lift * Math.sin(u * Math.PI * 0.6) + 40 * u * u, a);
        }
        if (!left) {
          C.phase = 'gap';
          C.t = 0;
        }
      }
      cctx.globalAlpha = 1;
    }

    // ------------------------------------------------------------ dunes
    // Smooth, asymmetric dunes - a long windward slope, a steeper slip face -
    // shaded by how squarely each slope faces the moon, rimmed with its light
    // along the crest, and grained like sand. Each layer is drawn once into a
    // tile that repeats seamlessly, then slid along with the wind.

    function buildDunes() {
      if (!duneCanvas) return;
      // Dunes have a size of their own, not the screen's: on a phone the same
      // waves squeezed into 390px stood up like mountains. A narrow screen
      // sees a slice of a wide tile, and lower dunes.
      const period = Math.max(1400, Math.ceil(W));
      const tall = Math.min(Math.max(H, 640), 900) * (W < 700 ? 0.62 : 1);
      const maxH = Math.ceil(DUNES[0].height * tall) + 4;
      duneCanvas.style.height = `${maxH}px`;
      duneCanvas.width = Math.round(duneCanvas.clientWidth * dpr);
      duneCanvas.height = Math.round(maxH * dpr);
      dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dunes = DUNES.map((D) => {
        const r = rand(D.seed);
        const harmonics = [2, 3, 5, 9].map((n, i) => ({ n, amp: [1, 0.55, 0.28, 0.1][i], phase: r() * Math.PI * 2, skew: 0.45 + r() * 0.25 }));
        // Whole periods across the tile, so it repeats without a seam. Each
        // wave is skewed, which gives the dune its gentle and its steep side.
        const profile = (x) => {
          const u = (x / period) * Math.PI * 2;
          let v = 0;
          for (const h of harmonics) {
            const a = h.n * u + h.phase;
            v += h.amp * Math.sin(a + h.skew * Math.sin(a));
          }
          return v;
        };
        const cols = Math.round(period * dpr);
        const raw = new Float32Array(cols + 2);
        for (let i = 0; i < cols + 2; i++) raw[i] = profile((i - 1) / dpr);
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of raw) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        const top = D.height * tall;
        const heights = raw.map((v) => top * (0.32 + 0.68 * ((v - lo) / (hi - lo))));

        const tile = document.createElement('canvas');
        tile.width = cols;
        tile.height = Math.round(maxH * dpr);
        const g = tile.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);

        // The body, one device pixel at a time, lit by its slope.
        const lightAt = [];
        for (let i = 0; i < cols; i++) {
          const h = heights[i + 1];
          const slope = ((heights[i + 2] - heights[i]) / 2) * dpr;
          const len = Math.hypot(slope, 1);
          const lambert = Math.max(0, (-slope * LIGHT[0] + LIGHT[1]) / len);
          const light = Math.pow(lambert, 1.6);
          lightAt.push(light);
          g.fillStyle = css(mix(D.body, D.lit, 0.12 + 0.88 * light));
          g.fillRect(i / dpr, maxH - h, 1 / dpr, h);
        }

        // The grain of the sand: faint flecks, a little lighter or darker.
        g.save();
        g.beginPath();
        g.moveTo(0, maxH);
        for (let i = 0; i < cols; i++) g.lineTo(i / dpr, maxH - heights[i + 1]);
        g.lineTo(period, maxH);
        g.closePath();
        g.clip();
        const flecks = Math.round((period * maxH) / 14);
        for (let i = 0; i < flecks; i++) {
          const light = r() < 0.5;
          g.globalAlpha = 0.04 + r() * 0.1;
          g.fillStyle = light ? css(D.lit, 1.25) : css(NIGHT);
          g.fillRect(r() * period, r() * maxH, 1 / dpr, 1 / dpr);
        }
        // Wind ripples on the nearest dune: faint lines that follow its crest.
        for (let j = 1; j <= D.ripples; j++) {
          g.globalAlpha = 0.08 - j * 0.01;
          g.strokeStyle = css(D.lit, 1.2);
          g.lineWidth = 1 / dpr;
          g.beginPath();
          for (let x = 0; x <= period; x += 2) {
            const i = Math.min(cols - 1, Math.round(x * dpr));
            const y = maxH - heights[i + 1] + 5 + j * 7 + 1.6 * Math.sin(x / 19 + j * 1.9);
            if (x === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.stroke();
        }
        g.restore();

        // The moon's rim of light along the crest, brightest on the slopes that face it.
        g.lineWidth = 1.1;
        g.lineCap = 'round';
        g.strokeStyle = css(mix(D.lit, MOON, 0.4));
        const step = Math.max(1, Math.round(2 * dpr));
        for (let i = 0; i < cols - step; i += step) {
          g.globalAlpha = 0.08 + 0.7 * lightAt[i];
          g.beginPath();
          g.moveTo(i / dpr, maxH - heights[i + 1] + 0.5);
          g.lineTo((i + step) / dpr, maxH - heights[i + step + 1] + 0.5);
          g.stroke();
        }
        g.globalAlpha = 1;

        // Darker towards the foot, and fading out where it tucks under the window.
        g.globalCompositeOperation = 'source-atop';
        const shade = g.createLinearGradient(0, 0, 0, maxH);
        shade.addColorStop(0, 'rgba(14,17,22,0)');
        shade.addColorStop(1, 'rgba(14,17,22,0.55)');
        g.fillStyle = shade;
        g.fillRect(0, 0, period, maxH);
        g.globalCompositeOperation = 'destination-in';
        const fade = g.createLinearGradient(0, 0, 0, maxH);
        fade.addColorStop(0, '#000');
        fade.addColorStop(0.45, '#000');
        fade.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = fade;
        g.fillRect(0, 0, period, maxH);
        return { ...D, tile, period, maxH, offset: 0 };
      });
    }

    function drawDunes(dt) {
      if (!dctx || !dunes.length) return;
      const box = duneCanvas.getBoundingClientRect();
      if (box.bottom < -40 || box.top > H + 40) return;
      const w = duneCanvas.clientWidth;
      dctx.clearRect(0, 0, w, dunes[0].maxH);
      for (const D of dunes) {
        D.offset = (D.offset + D.drift * wind(w / 2) * dt) % D.period;
        // Whole device pixels, so the grain of the sand stays sharp as it slides.
        const ox = Math.round(-D.offset * dpr) / dpr;
        for (let x = ox; x < w; x += D.period) dctx.drawImage(D.tile, x, 0, D.period, D.maxH);
      }
    }

    // ------------------------------------------------------------ the loop

    function frame(now) {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      clock += dt;
      ctx.clearRect(0, 0, W, H);
      if (cast) drawCastle(dt);
      if (!cast || !cast.first) fieldAlpha = Math.min(1, fieldAlpha + dt / 1.6);
      drawField(dt);
      drawPuffs(dt);
      ctx.globalAlpha = 1;
      drawDunes(dt);
      raf = requestAnimationFrame(frame);
    }

    function still() {
      fieldAlpha = 1;
      ctx.clearRect(0, 0, W, H);
      drawField(0);
      ctx.globalAlpha = 1;
      drawDunes(0);
    }

    function wake() {
      if (reduced.matches || document.hidden) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    }

    function showCastle() {
      for (const rect of castle.querySelectorAll('rect')) rect.style.opacity = '1';
    }

    // From here the castle's parts answer to this script, not the CSS safety net.
    document.documentElement.classList.add('sand-on');
    size();
    makeField();

    if (reduced.matches || !cctx) {
      showCastle();
      still();
    } else {
      cast = makeCastle();
      // A visitor who lands at the top watches it built; one further down
      // finds it standing, and sees it rebuilt on its next turn.
      if (window.scrollY < 200) startBuild(cast);
      else {
        cast.first = false;
        showCastle();
        }
      new IntersectionObserver(([e]) => (castleVisible = e.isIntersecting)).observe(castleCanvas);
      wake();
    }

    let lastW = W;
    window.addEventListener('resize', () => {
      // A phone's address bar changes the height while scrolling; only a new
      // width, or a much taller window, rebuilds.
      if (canvas.clientWidth === lastW && Math.abs(canvas.clientHeight - H) < 140) return;
      lastW = canvas.clientWidth;
      size();
      makeField();
      // The castle may have changed size: its sand is laid out again, standing.
      if (cast) {
        cast = makeCastle();
        cast.first = false;
        showCastle();
      }
      if (reduced.matches) still();
    });
    // Without motion, the dunes still have to follow the page.
    window.addEventListener('scroll', () => reduced.matches && requestAnimationFrame(still), { passive: true });
    window.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType === 'touch') return;
        const dt = Math.max(0.016, clock - pointer.at);
        pointer.vx = (e.clientX - pointer.x) / dt;
        pointer.vy = (e.clientY - pointer.y) / dt;
        if (Math.abs(pointer.vx) > 4000 || Math.abs(pointer.vy) > 4000) pointer.vx = pointer.vy = 0;
        pointer.x = e.clientX;
        pointer.y = e.clientY;
        pointer.at = clock;
      },
      { passive: true },
    );
    // Knock it down: it blows away and builds itself again.
    (castle.closest('button') || castle).addEventListener('click', (e) => {
      puff(e.clientX, e.clientY, 44, 1.2);
      if (cast && cast.phase === 'hold') startErode(cast);
    });
    document.addEventListener('visibilitychange', () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = 0;
        wake();
      }
    });
    reduced.addEventListener('change', () => {
      cancelAnimationFrame(raf);
      if (cast) {
        cast.phase = 'hold';
        cast.t = 0;
        cctx.clearRect(0, 0, castleCanvas.width, castleCanvas.height);
      }
      showCastle();
      if (reduced.matches) still();
      else wake();
    });

    return { puff };
  }

  window.SandcastleSand = sand;
})();
