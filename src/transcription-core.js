'use strict';
// Pure transcription timing and text functions; shared by the window and Node tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.transcriptionCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // 00:12,4 for the screen and the timings; 00:00:12,400 for .srt.
  function trTime(sec, full) {
    var ms = Math.round(Math.max(0, sec) * 1000), hh = Math.floor(ms / 3600000), mm = Math.floor(ms / 60000) % 60, ss = Math.floor(ms / 1000) % 60;
    var p = function (n, w) { return String(n).padStart(w || 2, "0"); };
    if (full) return p(hh) + ":" + p(mm) + ":" + p(ss) + "," + p(ms % 1000, 3);
    return (hh ? hh + ":" : "") + p(mm) + ":" + p(ss) + "," + Math.floor(ms % 1000 / 100);
  }
  function trShort(sec) { var s = Math.floor(sec), m = Math.floor(s / 60); return (m >= 60 ? Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0") : String(m)) + ":" + String(s % 60).padStart(2, "0"); }

  // Where the voice is. 30 ms frames; a frame is speech if it is louder than the quiet background of this file.
  // Short gaps inside a phrase are glued; a piece with less than MIN_SPEECH of loud frames is a click or a breath and is
  // not sent. The threshold is soft and the margins are wide on purpose: a lost word is worse than a second of pause.
  // A very long phrase is cut in its longest pause between 12 and 20 seconds (cutting in the quietest single moment
  // can fall inside a word). Every quiet stretch of at least MIN_PAUSE is remembered: timings are put on them.
  var VAD = { FRAME: 0.03, GAP: 0.8, PAD: 0.4, MIN_SPEECH: 0.3, MIN_PAUSE: 0.15, OVER_FLOOR: 7, MAX_LEN: 20, CUT_FROM: 12 };
  function findSpeech(data, rate, options) {
    var F = VAD.FRAME, size = Math.round(rate * F), n = Math.floor(data.length / size), db = new Float32Array(n), f, i;
    for (f = 0; f < n; f++) {
      var sum = 0;
      for (i = f * size; i < (f + 1) * size; i++) sum += data[i] * data[i];
      db[f] = 10 * Math.log10(sum / size + 1e-12);
    }
    return findSpeechLevels(db, options);
  }
  // The streaming reader can supply the same 30 ms loudness measurements without holding decoded audio in memory.
  function findSpeechLevels(db, options) {
    var F = VAD.FRAME, n = db.length, f;
    // Typed arrays sort numerically without boxing every frame into a separate JS number.
    var sorted = db.slice().sort();
    var floor = sorted[Math.floor(n * 0.2)] || -90, thr = Math.max(floor + VAD.OVER_FLOOR, -60);
    // Only after explicit user choice: a recording without quiet stretches can have a floor almost as loud as speech.
    if (options && options.flatFallback && n) thr = Math.max(-60, Math.min(thr, sorted[Math.floor(n * 0.99)] - 3));
    var regions = [], pauses = [], start = -1, last = -1, loud = 0, quiet = -1;
    for (f = 0; f < n; f++) {
      if (db[f] < thr) { if (quiet < 0) quiet = f; continue; }
      if (quiet >= 0 && (f - quiet) * F >= VAD.MIN_PAUSE) pauses.push([quiet * F, f * F]);
      quiet = -1;
      if (start < 0) start = f;
      else if ((f - last) * F > VAD.GAP) { regions.push([start, last, loud]); start = f; loud = 0; }
      last = f; loud++;
    }
    if (start >= 0) regions.push([start, last, loud]);
    var out = [], end = n * F;
    regions.forEach(function (r) {
      if (r[2] * F < VAD.MIN_SPEECH) return;
      // a, b — what is sent (with margins); sa, sb — where the voice really starts and stops (for the timings).
      var p = { a: Math.max(0, r[0] * F - VAD.PAD), b: Math.min(end, (r[1] + 1) * F + VAD.PAD), sa: r[0] * F, sb: (r[1] + 1) * F };
      var prev = out[out.length - 1];
      if (prev && p.a <= prev.b) { p.a = prev.a; p.sa = prev.sa; out.pop(); }
      while (p.b - p.a > VAD.MAX_LEN) {
        var lo = p.a + VAD.CUT_FROM, hi = p.a + VAD.MAX_LEN, best = null;
        pauses.forEach(function (q) { if (q[0] >= lo && q[1] <= hi && (!best || q[1] - q[0] > best[1] - best[0])) best = q; });
        if (!best) best = quietestStretch(db, lo, hi);
        var cut = (best[0] + best[1]) / 2;
        out.push({ a: p.a, b: cut, sa: p.sa, sb: best[0] });
        p = { a: cut, b: p.b, sa: best[1], sb: p.sb };
      }
      out.push(p);
    });
    return { pieces: out, pauses: pauses };
  }
  // No pause at all between 12 and 20 seconds: the quietest quarter of a second there, never one short moment.
  function quietestStretch(db, lo, hi) {
    var F = VAD.FRAME, w = Math.round(0.24 / F), from = Math.floor(lo / F), to = Math.floor(hi / F) - w, best = from, bestSum = Infinity;
    for (var k = from; k <= to; k++) {
      var s = 0;
      for (var j = k; j < k + w; j++) s += db[j];
      if (s < bestSum) { bestSum = s; best = k; }
    }
    return [best * F, (best + w) * F];
  }
  // Splits the time from start to end between parts of text: first by length, then each border moves to the nearest
  // real pause within `reach` seconds — the phrase ends where the voice stops and the next starts where it begins again.
  function placeParts(start, end, parts, pauses, reach) {
    var total = parts.reduce(function (a, p) { return a + p.length; }, 0) || 1;
    var inside = pauses.filter(function (q) { return q[0] > start && q[1] < end; });
    var out = [], from = start, used = -1, acc = 0;
    for (var i = 0; i < parts.length; i++) {
      if (i === parts.length - 1) { out.push([from, end]); break; }
      acc += parts[i].length;
      var guess = start + (end - start) * acc / total, pick = -1;
      for (var k = used + 1; k < inside.length; k++) {
        var mid = (inside[k][0] + inside[k][1]) / 2;
        if (Math.abs(mid - guess) <= reach && (pick < 0 || Math.abs(mid - guess) < Math.abs((inside[pick][0] + inside[pick][1]) / 2 - guess))) pick = k;
      }
      if (pick >= 0) { out.push([from, inside[pick][0]]); from = inside[pick][1]; used = pick; }
      else { out.push([from, guess]); from = guess; }
    }
    return out;
  }
  function splitSentences(text) { return String(text || "").trim().split(/(?<=[.!?…])\s+/).filter(Boolean); }
  // Pieces → phrases. A long piece may be cut in a pause in the middle of a sentence: the halves are glued back.
  // A piece with a speaker gives phrases with it; halves are glued only when it is the same person.
  function sentencesOf(segments, pauses) {
    var out = [];
    segments.forEach(function (s) {
      var parts = splitSentences(s.text);
      placeParts(s.start, s.end, parts, pauses, 3).forEach(function (t, i) {
        var prev = out[out.length - 1];
        if (i === 0 && prev && prev.speaker === s.speaker && !/[.!?…]["»)]?$/.test(prev.text) && t[0] - prev.end < 1.5) { prev.text += " " + parts[0]; prev.end = t[1]; }
        else { var c = { start: t[0], end: t[1], text: parts[i] }; if (s.speaker) c.speaker = s.speaker; out.push(c); }
      });
    });
    return out;
  }
  // Two halves where it reads best: at a comma, dash, colon or semicolon near the middle, else at the space nearest it.
  function halves(text, max) {
    var mid = text.length / 2, best = -1, re = /[,;:]\s|\s[—–-]\s/g, m;
    while ((m = re.exec(text))) { var at = m[0][0] === " " ? m.index : m.index + 1; if (best < 0 || Math.abs(at - mid) < Math.abs(best - mid)) best = at; }
    if (best < text.length * 0.25 || best > text.length * 0.75 || (max && Math.max(best, text.length - best) > max)) {
      best = -1;
      for (var i = 0; i < text.length; i++) if (text[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    }
    return best <= 0 ? [text] : [text.slice(0, best).trim(), text.slice(best).trim()];
  }
  function chunksOf(text, max) {
    if (text.length <= max) return [text];
    var hv = halves(text);
    return hv.length < 2 ? [text] : chunksOf(hv[0], max).concat(chunksOf(hv[1], max));
  }
  // Subtitles: at most two lines of about 42 letters; a longer phrase becomes several, split at commas and dashes,
  // with their borders on the pauses too.
  function subtitlesOf(t) {
    var out = [];
    t.cues.forEach(function (c) {
      var parts = chunksOf(cueText(c), 84);
      placeParts(c.start, c.end, parts, t.pauses || [], 1.5).forEach(function (x, i) {
        out.push({ start: x[0], end: x[1], text: (parts[i].length > 42 ? halves(parts[i], 44) : [parts[i]]).join("\n") });
      });
    });
    return out;
  }
  function srtOf(t) {
    return subtitlesOf(t).map(function (s, i) { return (i + 1) + "\n" + trTime(s.start, true) + " --> " + trTime(s.end, true) + "\n" + s.text + "\n"; }).join("\n");
  }
  function timingsOf(t, fmt) {
    return t.cues.map(function (c) {
      return fmt === "prompt" ? "[" + trShort(c.start) + "–" + trShort(c.end) + "] " + cueText(c) : trTime(c.start) + " – " + trTime(c.end) + "  " + cueText(c);
    }).join("\n");
  }
  // With several voices every phrase says who it is: «Собеседник 1: …».
  function cueText(c) { return c.speaker ? c.speaker + ": " + c.text : c.text; }
  // Phrases of the same person in a row make one paragraph «Собеседник 1: …»; paragraphs are split by an empty line.
  function speakerGroups(cues) {
    var out = [];
    cues.forEach(function (c) {
      var g = out[out.length - 1];
      if (g && g.speaker === c.speaker) { g.cues.push(c); g.end = c.end; } else out.push({ speaker: c.speaker, start: c.start, end: c.end, cues: [c] });
    });
    return out;
  }
  function speakerText(cues) {
    return speakerGroups(cues).map(function (g) { return g.speaker + ": " + g.cues.map(function (c) { return c.text; }).join(" "); }).join("\n\n");
  }
  return { trTime, trShort, findSpeech, findSpeechLevels, placeParts, splitSentences, sentencesOf, subtitlesOf, srtOf, timingsOf, cueText, speakerGroups, speakerText };
});
