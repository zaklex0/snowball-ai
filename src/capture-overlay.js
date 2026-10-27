'use strict';
(() => {
  const api = window.vsApi,
    canvas = document.getElementById('selection'),
    ctx = canvas.getContext('2d');
  let a = null,
    b = null,
    square = false,
    choosing = false,
    ready = false;
  const point = (e) => ({
    x: Math.max(0, Math.min(innerWidth, e.clientX)),
    y: Math.max(0, Math.min(innerHeight, e.clientY)),
  });
  function rect() {
    let dx = b.x - a.x,
      dy = b.y - a.y;
    if (square) {
      const size = Math.min(
        Math.max(Math.abs(dx), Math.abs(dy)),
        dx < 0 ? a.x : innerWidth - a.x,
        dy < 0 ? a.y : innerHeight - a.y,
      );
      dx = (dx < 0 ? -1 : 1) * size;
      dy = (dy < 0 ? -1 : 1) * size;
    }
    return {
      x: Math.min(a.x, a.x + dx),
      y: Math.min(a.y, a.y + dy),
      w: Math.abs(dx),
      h: Math.abs(dy),
    };
  }
  function draw() {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    ctx.fillStyle = '#0006';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!a || !b) return;
    const r = rect();
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = '#F4AA84';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
  async function choose(r) {
    if (choosing || !ready) return;
    choosing = true;
    const result = await api.captureChoose(r);
    if (!result.ok) {
      choosing = false;
      document.getElementById('hint').textContent = result.error + ' · Esc — отмена';
    }
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !ready) return;
    a = point(e);
    b = a;
    square = e.shiftKey;
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!a || choosing) return;
    b = point(e);
    square = e.shiftKey;
    draw();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !a) return;
    b = point(e);
    square = e.shiftKey;
    const r = rect();
    if (r.w < 3 || r.h < 3) {
      a = b = null;
      draw();
      return;
    }
    choose({
      x: r.x / innerWidth,
      y: r.y / innerHeight,
      w: r.w / innerWidth,
      h: r.h / innerHeight,
    });
  });
  canvas.addEventListener('pointercancel', () => {
    a = b = null;
    draw();
  });
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    choose({ x: 0, y: 0, w: 1, h: 1 });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.captureCancel();
    if (e.key === 'Shift') {
      square = true;
      draw();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
      square = false;
      draw();
    }
  });
  window.addEventListener('resize', draw);
  // The window lives between captures (hidden): every capture brings a new frame, closing it brings a reset.
  const shot = document.getElementById('screen'),
    shotCtx = shot.getContext('2d'),
    hint = document.getElementById('hint'),
    hintText = hint.textContent;
  function reset() {
    a = b = null;
    square = choosing = ready = false;
    hint.textContent = hintText;
    shot.width = shot.height = 1;
    window.captureShownAt = 0;
    draw();
  }
  api.onCaptureReset(reset);
  api.onCaptureFrame(({ width, height, pixels }) => {
    reset();
    // Windows gives the pixels as B, G, R, A; the canvas wants R, G, B, A.
    const bytes = pixels.byteOffset % 4 ? pixels.slice() : pixels;
    const src = new Uint32Array(bytes.buffer, bytes.byteOffset, width * height);
    const image = new ImageData(width, height),
      dst = new Uint32Array(image.data.buffer);
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      dst[i] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff);
    }
    shot.width = width;
    shot.height = height;
    shotCtx.putImageData(image, 0, 0);
    ready = true;
    draw();
    window.captureShownAt = Date.now(); // read by tools/screenshot-timing.cjs
    api.captureReady();
  });
})();
