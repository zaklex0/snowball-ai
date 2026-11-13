'use strict';
// Centre the rasterised ink, not the font's advance, baseline or line box.
// The circle and the glyph share one canvas and exactly the same pixel centre.
(() => {
  const SCALE = 8;
  function paint(button, value, guides = false) {
    if (!button.isConnected || button.offsetWidth <= 2 || button.offsetHeight <= 2) return;
    const probe = button.cloneNode(false);
    probe.style.removeProperty('border-color');
    probe.style.removeProperty('background');
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    probe.removeAttribute('data-stamped-number');
    button.parentNode.append(probe);
    const style = getComputedStyle(probe);
    const ring = style.borderTopColor, fill = style.backgroundColor, ink = style.color;
    const family = style.fontFamily;
    probe.remove();
    // Layout dimensions are independent of the enlargement used on the test page.
    const size = { width: button.offsetWidth, height: button.offsetHeight };
    const width = Math.round(size.width * SCALE), height = Math.round(size.height * SCALE);
    const scratch = document.createElement('canvas');
    scratch.width = 512; scratch.height = 512;
    const sg = scratch.getContext('2d', { willReadFrequently: true });
    sg.font = '400 ' + (11 * SCALE) + 'px ' + family;
    sg.fillStyle = ink;
    sg.textBaseline = 'alphabetic';
    sg.fillText(String(value), 96, 256);
    const pixels = sg.getImageData(0, 0, scratch.width, scratch.height).data;
    let left = 512, top = 512, right = -1, bottom = -1;
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      if (pixels[(y * 512 + x) * 4 + 3] !== 0) {
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    if (right < left || bottom < top) return;
    const sw = right - left + 1, sh = bottom - top + 1;
    const ratio = Math.min(1, (width - 5 * SCALE) / sw, (height - 5 * SCALE) / sh);
    const dw = sw * ratio, dh = sh * ratio;
    const dx = (width - dw) / 2, dy = (height - dh) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.className = 'task-number-stamp';
    canvas.setAttribute('aria-hidden', 'true');
    // Include the transparent CSS border in the small canvas's coordinate system.
    Object.assign(canvas.style, { position: 'absolute', left: '-1px', top: '-1px', width: size.width + 'px', height: size.height + 'px', pointerEvents: 'none' });
    const g = canvas.getContext('2d');
    g.beginPath();
    g.ellipse(width / 2, height / 2, width / 2 - SCALE / 2, height / 2 - SCALE / 2, 0, 0, Math.PI * 2);
    g.fillStyle = fill; g.fill();
    g.lineWidth = SCALE; g.strokeStyle = ring; g.stroke();
    g.drawImage(scratch, left, top, sw, sh, dx, dy, dw, dh);
    if (guides) {
      g.strokeStyle = 'rgba(0,122,255,.5)'; g.lineWidth = SCALE * 0.25;
      g.beginPath(); g.moveTo(width / 2, 0); g.lineTo(width / 2, height);
      g.moveTo(0, height / 2); g.lineTo(width, height / 2); g.stroke();
      g.strokeStyle = 'rgba(230,80,90,.75)'; g.strokeRect(dx, dy, dw, dh);
    }
    button.replaceChildren(canvas);
    button.style.borderColor = 'transparent';
    button.style.background = 'transparent';
    button.dataset.stampedNumber = value;
    button.dataset.inkCenter = ((dx + dw / 2) / SCALE) + ',' + ((dy + dh / 2) / SCALE);
    return { centre: [size.width / 2, size.height / 2], inkCentre: [(dx + dw / 2) / SCALE, (dy + dh / 2) / SCALE], inkBox: [dx / SCALE, dy / SCALE, dw / SCALE, dh / SCALE] };
  }
  window.SnowTaskNumberStamp = { paint };
  function pending() {
    document.querySelectorAll('button[data-task-number]').forEach(b => {
      if (b.dataset.taskNumber !== b.dataset.stampedNumber) paint(b, b.dataset.taskNumber);
    });
  }
  // Paint after renderer updates have attached the buttons to their actual column/theme.
  new MutationObserver(pending).observe(document.body, { childList: true, subtree: true });
  document.fonts.ready.then(() => document.querySelectorAll('button[data-task-number]').forEach(b => paint(b, b.dataset.taskNumber)));
  let repaint = 0;
  new MutationObserver(() => {
    cancelAnimationFrame(repaint);
    repaint = requestAnimationFrame(() => document.querySelectorAll('[data-stamped-number]').forEach(b => paint(b, b.dataset.stampedNumber)));
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent', 'class'] });
})();
