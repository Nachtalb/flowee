// The landing page's motion: scroll reveal, the cards' pointer glow, copy buttons, the flow diagram and the hero's
// particle wave (raw WebGL, no library). Everything here is optional: without it the page reads the same.
(() => {
  "use strict";
  const root = document.documentElement;
  root.classList.add("js");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const light = matchMedia("(prefers-color-scheme: light)");
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // scroll reveal, staggered among siblings
  const reveals = $$(".reveal");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    for (const el of reveals) {
      const sibs = [...el.parentElement.children].filter((c) => c.classList.contains("reveal"));
      el.style.transitionDelay = `${Math.min(sibs.indexOf(el), 6) * 70}ms`;
      io.observe(el);
    }
  } else for (const el of reveals) el.classList.add("in");

  // a soft glow under the pointer on cards
  document.addEventListener("pointermove", (e) => {
    const c = e.target instanceof Element && e.target.closest(".glow");
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty("--mx", `${e.clientX - r.left}px`);
    c.style.setProperty("--my", `${e.clientY - r.top}px`);
  });

  // copy buttons
  for (const b of $$("[data-copy]")) {
    b.setAttribute("aria-live", "polite");
    b.addEventListener("click", async () => {
      const el = document.getElementById(b.dataset.copy);
      try {
        await navigator.clipboard.writeText(el.textContent);
      } catch {
        const r = document.createRange();
        r.selectNodeContents(el);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        document.execCommand("copy");
      }
      b.textContent = "Copied";
      b.classList.add("done");
      setTimeout(() => {
        b.textContent = "Copy";
        b.classList.remove("done");
      }, 1600);
    });
  }

  // the flow diagram: a ticket card walks the states
  const box = $(".flow-box");
  if (box) {
    const steps = $$(".flow li", box);
    const ticket = $(".ticket", box);
    const OWNER = 6;
    steps[OWNER].classList.add("owner-step");
    let k = 0;
    let timer = 0;
    let seen = false;
    const place = () => {
      const b = box.getBoundingClientRect();
      const r = steps[k].getBoundingClientRect();
      ticket.style.transform = `translate(${r.right - b.left - 50}px, ${r.top - b.top + 10}px) rotate(-8deg)`;
      steps.forEach((s, i) => {
        s.classList.toggle("on", i === k);
        s.classList.toggle("done-step", i < k);
      });
    };
    const loop = () => {
      clearInterval(timer);
      timer = 0;
      if (reduce.matches) {
        k = OWNER;
        place();
      } else if (seen && !document.hidden) timer = setInterval(() => ((k = (k + 1) % steps.length), place()), k === OWNER ? 2600 : 1900);
    };
    new IntersectionObserver(([e]) => ((seen = e.isIntersecting), loop())).observe(box);
    document.addEventListener("visibilitychange", loop);
    reduce.addEventListener("change", loop);
    addEventListener("resize", place);
    place();
  }

  // the hero's particle wave
  const hero = $(".hero");
  const canvas = $(".wave", hero);
  const gl = canvas && canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl) return;

  const VERT = `
precision highp float;
attribute vec4 aP; // u along the band, v across it (-1..1), band, seed
uniform vec2 uRes;
uniform float uT, uDpr, uCL, uCR, uAmp, uThick, uLight;
uniform vec3 uM; // the eased pointer (css px) and its strength
uniform vec4 uText; // the hero text's box (css px): the wave dims behind it
uniform vec3 uB0, uB1, uB2, uB3, uB4, uB5, uHi, uAmber;
varying vec4 vCol;
varying vec3 vShape; // length, width, box (device px)
varying vec2 vDir;

float swell(float x, float b) {
  float p = b * 1.9;
  return 0.6 * sin(x / 230.0 - uT * 0.42 + p) + 0.28 * sin(x / 108.0 - uT * 0.7 + p * 2.1) + 0.12 * sin(x / 52.0 - uT * 1.1 + p * 0.7);
}
float across(float x, float b) {
  return 0.82 + 0.3 * sin(x / 170.0 - uT * 0.35 + b * 2.0);
}
float yAt(float x, float v, float b, float off, float hw) {
  return uRes.y * mix(uCL, uCR, smoothstep(0.36, 0.92, x / uRes.x)) + uThick * off + uAmp * swell(x, b) + v * uThick * hw * across(x, b);
}

void main() {
  float b = aP.z;
  float seed = aP.w;
  float off = b < 0.5 ? -0.95 : (b < 1.5 ? 0.15 : 1.0);
  float hw = b < 0.5 ? 0.62 : (b < 1.5 ? 0.46 : 0.34);
  float u = fract(aP.x + uT * (0.010 + 0.003 * b));
  float x = (u * 1.16 - 0.08) * uRes.x;
  vec2 p = vec2(x, yAt(x, aP.y, b, off, hw));
  vec2 dir = normalize(vec2(4.0, yAt(x + 2.0, aP.y, b, off, hw) - yAt(x - 2.0, aP.y, b, off, hw)));
  p += vec2(sin(seed * 41.0 + uT * 0.9), cos(seed * 53.0 + uT * 0.8)) * 1.6;

  // the pointer pushes the wave aside; a ring just outside the hollow swells and brightens
  vec2 d = p - uM.xy;
  float r = 130.0;
  float dl = length(d);
  float f = exp(-dl * dl / (r * r)) * uM.z;
  p += d / (dl + 1.0) * f * 26.0;
  float ring = exp(-pow((length(p - uM.xy) - 0.5 * r) / (0.2 * r), 2.0)) * uM.z;
  f = max(f * 0.6, ring * 0.7);
  dir = normalize(mix(dir, normalize(d + 0.001), f * 0.35));

  float crest = clamp(0.5 - 0.5 * swell(x, b) / 0.9, 0.0, 1.0);
  float edge = 1.0 - smoothstep(0.4, 1.0, abs(aP.y));
  float fadeW = min(180.0, uRes.x * 0.16);
  float side = smoothstep(0.0, fadeW, p.x) * (1.0 - smoothstep(uRes.x - fadeW, uRes.x, p.x));

  float n = 0.5 + 0.5 * sin(p.x * 0.0045 + uT * 0.22 + 1.8 * sin(p.y * 0.006 - uT * 0.17 + b));
  vec3 col = b < 0.5 ? mix(uB0, uB1, n) : (b < 1.5 ? mix(uB2, uB3, n) : mix(uB4, uB5, n));
  col = mix(col, uHi, clamp(crest * crest * 0.6 + f * 0.4, 0.0, 1.0));
  float bandA = b < 0.5 ? 0.95 : (b < 1.5 ? 0.8 : 0.65);
  vec2 inText = smoothstep(uText.xy - 40.0, uText.xy + 20.0, p) * (1.0 - smoothstep(uText.zw - 20.0, uText.zw + 40.0, p));
  float a = ((0.34 + 0.66 * pow(crest, 1.3)) * bandA + f * 0.35) * edge * side * (1.0 - 0.7 * inText.x * inText.y);

  float len = (4.0 + 5.5 * crest) * (0.75 + 0.5 * fract(seed * 7.13)) * (1.0 - 0.12 * b);
  len *= 1.0 + 0.8 * f;
  float wid = max(1.7, len * 0.34);
  if (fract(seed * 91.7) < 0.012 && b < 0.5 && abs(aP.y) < 0.35) {
    col = uAmber;
    len = 11.0 + 5.0 * crest;
    wid = len * 0.72;
    a = min(1.0, a * 1.4 + 0.25 * edge * side);
  }
  vCol = vec4(col, clamp(a * (uLight > 0.5 ? 1.6 : 1.0), 0.0, 1.0));
  float box = len + 6.0;
  vShape = vec3(len, wid, box) * uDpr;
  vDir = dir;
  gl_PointSize = box * uDpr;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0);
}`;
  const FRAG = `
precision mediump float;
varying vec4 vCol;
varying vec3 vShape;
varying vec2 vDir;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * vShape.z;
  vec2 r = vec2(dot(q, vDir), dot(q, vec2(-vDir.y, vDir.x)));
  float h = max(0.0, 0.5 * (vShape.x - vShape.y));
  float d = length(vec2(max(abs(r.x) - h, 0.0), r.y)) - 0.5 * vShape.y;
  float a = vCol.a * (clamp(0.5 - d, 0.0, 1.0) + 0.22 * exp(-max(d, 0.0) * 0.55));
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol.rgb * a, a);
}`;

  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);
  const U = {};
  for (const n of ["uText", "uRes", "uT", "uDpr", "uCL", "uCR", "uAmp", "uThick", "uLight", "uM", "uB0", "uB1", "uB2", "uB3", "uB4", "uB5", "uHi", "uAmber"]) U[n] = gl.getUniformLocation(prog, n);
  const buf = gl.createBuffer();
  const aP = gl.getAttribLocation(prog, "aP");
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(aP);
  gl.vertexAttribPointer(aP, 4, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);

  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const PALETTES = {
    dark: { bands: ["#14b8a6", "#5eead4", "#5eead4", "#ccfbf1", "#ccfbf1", "#99f6e4"], hi: "#f0fdfa" },
    light: { bands: ["#0f766e", "#0d9488", "#0d9488", "#14b8a6", "#14b8a6", "#5eead4"], hi: "#134e4a" },
  };
  const theme = () => {
    const p = light.matches ? PALETTES.light : PALETTES.dark;
    p.bands.forEach((c, i) => gl.uniform3fv(U[`uB${i}`], hex(c)));
    gl.uniform3fv(U.uHi, hex(p.hi));
    gl.uniform3fv(U.uAmber, hex("#f59e0b"));
    gl.uniform1f(U.uLight, light.matches ? 1 : 0);
    if (light.matches) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);
  };

  let W = 0;
  let H = 0;
  let count = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // a jittered grid in the bands' own coordinates: even spacing without clumps
  const build = (thick) => {
    seed = 7;
    const sp = W < 700 ? 9 : 7.5;
    const cols = Math.ceil((W * 1.16) / sp);
    const out = [];
    [0.62, 0.46, 0.34].forEach((hw, b) => {
      const rows = Math.max(3, Math.round((2 * thick * hw) / sp));
      for (let i = 0; i < cols; i++)
        for (let j = 0; j < rows; j++) out.push((i + 0.5 + (rnd() - 0.5) * 0.7) / cols, ((j + 0.5 + (rnd() - 0.5) * 0.7) / rows) * 2 - 1, b, rnd());
    });
    count = out.length / 4;
    canvas.dataset.particles = String(count);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
  };
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = hero.clientWidth;
    const h = hero.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const content = $(".hero-in", hero);
    const bottom = content.offsetTop + content.offsetHeight;
    const box = [...content.children].reduce((r, el) => [Math.min(r[0], el.offsetLeft), Math.min(r[1], el.offsetTop), Math.max(r[2], el.offsetLeft + el.offsetWidth), Math.max(r[3], el.offsetTop + el.offsetHeight)], [w, h, 0, 0]);
    gl.uniform4f(U.uText, box[0] + content.offsetLeft, box[1] + content.offsetTop, box[2] + content.offsetLeft, box[3] + content.offsetTop);
    const thick = Math.min(h * 0.1, 84, w * 0.16);
    gl.uniform2f(U.uRes, w, h);
    gl.uniform1f(U.uDpr, dpr);
    gl.uniform1f(U.uThick, thick);
    gl.uniform1f(U.uAmp, Math.min(h * 0.09, 78, w * 0.13));
    // wide: low under the text on the left, rising to mid-height on the right; narrow: below the text
    const below = Math.min(0.86, Math.max(0.6, (bottom + (h - bottom) * 0.46) / h));
    const wide = w >= 1000;
    gl.uniform1f(U.uCL, wide ? Math.min(0.9, Math.max(0.62, (bottom + 120) / h)) : below);
    gl.uniform1f(U.uCR, wide ? 0.44 : below);
    if (w !== W || h !== H) {
      W = w;
      H = h;
      build(thick);
    }
  };

  let t = 9;
  const m = { x: 0, y: 0, s: 0, tx: 0, ty: 0, ts: 0 };
  const draw = () => {
    gl.uniform1f(U.uT, t);
    gl.uniform3f(U.uM, m.x, m.y, m.s);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, count);
  };

  const aim = (x, y) => {
    const r = canvas.getBoundingClientRect();
    m.tx = x - r.left;
    m.ty = y - r.top;
    m.ts = m.ty > 0 && m.ty < r.height ? 1 : 0;
    if (!m.s) ((m.x = m.tx), (m.y = m.ty));
  };
  addEventListener("pointermove", (e) => aim(e.clientX, e.clientY), { passive: true });
  addEventListener("touchstart", (e) => aim(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  addEventListener("touchmove", (e) => aim(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  addEventListener("touchend", () => (m.ts = 0), { passive: true });
  document.addEventListener("pointerleave", () => (m.ts = 0));

  let visible = true;
  let raf = 0;
  let last = 0;
  const running = () => visible && !document.hidden && !reduce.matches;
  const frame = (now) => {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    const k = 1 - Math.exp(-dt * 5);
    m.x += (m.tx - m.x) * k;
    m.y += (m.ty - m.y) * k;
    m.s += (m.ts - m.s) * (1 - Math.exp(-dt * 2.5));
    draw();
    if (running()) raf = requestAnimationFrame(frame);
  };
  const kick = () => {
    if (raf || !running()) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const still = () => {
    if (!reduce.matches) return kick();
    m.s = 0;
    draw();
  };

  theme();
  resize();
  draw();
  hero.classList.add("gl");
  new IntersectionObserver(([e]) => ((visible = e.isIntersecting), kick())).observe(hero);
  new ResizeObserver(() => (resize(), draw())).observe(hero);
  document.addEventListener("visibilitychange", kick);
  reduce.addEventListener("change", still);
  light.addEventListener("change", () => (theme(), draw()));
  canvas.addEventListener("webglcontextlost", (e) => (e.preventDefault(), hero.classList.remove("gl")));
  still();
})();
