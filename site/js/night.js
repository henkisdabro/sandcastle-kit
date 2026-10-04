// The night: one run played across a sky. The moon crosses from dusk to dawn
// with the run's clock beside it, and the castle on the dunes is the run's
// tickets - a block is outlined while its ticket is in work and filled with
// sand when its branch lands. The pointer winds the night back and forth.
// A plain script, not a module, so the page also works opened from disk.
(function () {
  'use strict';

  const RUN = 30; // minutes, as the status window plays them
  const END = 0.74; // how far along the arc the last branch lands; the rest is the night passing
  const DAWN = 0.84;
  const START = 22 * 60 + 41;
  const MORNING = 31 * 60 + 30; // 07:30 the next day
  const LENGTH = 26; // seconds from dusk to dawn
  const HOLD = 4;
  const STILL = END; // shown without motion: the run just finished

  // [minute, state] per ticket, the status window's own night: w in work,
  // m merged, r needs you, b blocked.
  const STEPS = {
    43: [[2, 'w'], [13, 'm']],
    42: [[2, 'w'], [17, 'm']],
    45: [[2, 'w'], [18, 'm']],
    41: [[2, 'w'], [22, 'm']],
    48: [[13, 'w'], [23, 'm']],
    49: [[14, 'w'], [24, 'm']],
    52: [[17, 'w'], [26, 'm']],
    53: [[18, 'w'], [27, 'm']],
    47: [[0, 'b'], [22, 'w'], [30, 'm']],
    46: [[2, 'w'], [14, 'r']],
    44: [[2, 'w'], [24, 'r']],
    50: [[0, 'b']],
    51: [[0, 'b']],
  };
  // The minute each moment below the sky begins; the last is the morning.
  const MOMENTS = [0, 2, 15, 30];

  const clamp = (v) => Math.max(0, Math.min(1, v));
  const smooth = (u) => u * u * (3 - 2 * u);
  const two = (n) => String(n).padStart(2, '0');

  function night({ root, puff, reduced }) {
    const sky = root.querySelector('.sky');
    const moon = sky.querySelector('.moon');
    const clock = sky.querySelector('.moon-clock');
    const path = sky.querySelector('.arc path');
    const blocks = [...sky.querySelectorAll('.keep span')];
    const tally = Object.fromEntries([...sky.querySelectorAll('[data-n]')].map((b) => [b.dataset.n, b]));
    const moments = [...root.querySelectorAll('.moments li')];

    let W = 0;
    let H = 0;
    let arc = null;
    let p = 0;
    let held = 0;
    let visible = false;
    let winding = false;
    let raf = 0;
    let last = 0;

    // Stars in the status header's own glyphs, laid out once from a fixed seed.
    let seed = 41;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const stars = sky.querySelector('.stars');
    for (let i = 0; i < 90; i++) {
      const s = document.createElement('span');
      s.textContent = rnd() < 0.3 ? '+' : '·';
      s.style.cssText = `left:${(rnd() * 100).toFixed(2)}%;top:${(rnd() * 68).toFixed(2)}%;opacity:${(0.35 + rnd() * 0.65).toFixed(2)};animation-delay:${(-rnd() * 6).toFixed(2)}s;animation-duration:${(3.5 + rnd() * 4).toFixed(2)}s`;
      stars.append(s);
    }

    function layout() {
      W = sky.clientWidth;
      H = sky.clientHeight;
      const ground = Math.max(44, H * 0.15);
      sky.style.setProperty('--ground', `${ground}px`);
      const d = moon.offsetWidth;
      // It rises and sets below the sky's foot: the dunes fade out there, and
      // would show it through.
      const y = H + d;
      // Clear of the edges by more than its own width, so a narrow screen cuts neither it nor its clock.
      const inset = Math.max(W * 0.05, d * 1.3);
      arc = [inset, y, W * 0.5, -H * 0.52, W - inset, y];
      sky.querySelector('.arc').setAttribute('viewBox', `0 0 ${W} ${H}`);
      path.setAttribute('d', `M ${arc[0]} ${arc[1]} Q ${arc[2]} ${arc[3]} ${arc[4]} ${arc[5]}`);
      draw(false);
    }

    function draw(dust) {
      const t = p;
      const x = (1 - t) ** 2 * arc[0] + 2 * t * (1 - t) * arc[2] + t * t * arc[4];
      const y = (1 - t) ** 2 * arc[1] + 2 * t * (1 - t) * arc[3] + t * t * arc[5];
      const d = moon.offsetWidth;
      moon.style.transform = `translate(${x - d / 2}px, ${y - d / 2}px)`;
      const dawn = smooth(clamp((p - DAWN) / (1 - DAWN)));
      sky.style.setProperty('--dawn', dawn.toFixed(3));

      const minute = Math.min(RUN, (p / END) * RUN);
      // Once the run is over the clock races through the small hours.
      const at = p <= END ? START + minute : START + RUN + ((p - END) / (1 - END)) * (MORNING - START - RUN);
      clock.textContent = `${two(Math.floor(at / 60) % 24)}:${two(Math.floor(at % 60))}`;

      const count = { w: 0, r: 0, m: 0 };
      for (const b of blocks) {
        let state = '';
        for (const [from, s] of STEPS[b.dataset.t]) if (minute >= from) state = s;
        if (state in count) count[state]++;
        if (b.className === state) continue;
        b.className = state;
        if (dust && state === 'm') {
          const box = b.getBoundingClientRect();
          puff(box.left + box.width / 2, box.bottom);
        }
      }
      for (const k in count) tally[k].textContent = count[k];

      const now = p >= 0.93 ? 4 : MOMENTS.findLastIndex((from) => minute >= from);
      moments.forEach((li, i) => {
        li.classList.toggle('on', i === now);
        li.classList.toggle('done', i < now);
      });
    }

    function tick(now) {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!winding) {
        if (p >= 1) {
          if ((held += dt) > HOLD) {
            held = 0;
            p = 0;
            draw(false);
          }
        } else {
          p = Math.min(1, p + dt / LENGTH);
          draw(true);
        }
      }
      raf = requestAnimationFrame(tick);
    }

    function play() {
      cancelAnimationFrame(raf);
      if (reduced.matches) {
        p = STILL;
        draw(false);
        return;
      }
      if (!visible || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }

    let downX = 0;
    sky.addEventListener('pointerdown', (e) => (downX = e.clientX));
    sky.addEventListener('pointermove', (e) => {
      if (reduced.matches) return;
      // A finger scrolling the page past the sky is not winding it: only a sideways move is.
      if (e.pointerType !== 'mouse' && !winding && Math.abs(e.clientX - downX) < 12) return;
      const box = sky.getBoundingClientRect();
      const to = clamp((e.clientX - box.left - arc[0]) / (arc[4] - arc[0]));
      winding = true;
      const forward = to > p;
      p = to;
      held = 0;
      draw(forward);
    });
    for (const end of ['pointerleave', 'pointerup', 'pointercancel']) sky.addEventListener(end, () => (winding = false));

    if (reduced.matches) p = STILL;
    layout();
    new ResizeObserver(layout).observe(sky);
    new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting;
        play();
      },
      { threshold: 0.02 },
    ).observe(sky);
    document.addEventListener('visibilitychange', play);
    reduced.addEventListener('change', play);
  }

  window.SandcastleNight = night;
})();
