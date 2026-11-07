'use strict';
// Read/decode short portions of a chosen media file using the codecs already present in Electron.
(function () {
  var RATE = 16000, FRAME = 0.03, MAX_RANGE = 8 * 1024 * 1024;
  async function open(file, api) {
    var media = await import('../node_modules/mediabunny/dist/bundles/mediabunny.mjs');
    var source = new media.CustomSource({
      getSize: function () { return file.size; },
      prefetchProfile: 'fileSystem',
      maxCacheSize: MAX_RANGE,
      read: async function (start, end) {
        var parts = [], length = end - start;
        if (length > 64 * 1024 * 1024) throw new Error('Слишком большой фрагмент файла.');
        for (var p = start; p < end; p += MAX_RANGE) {
          var result = await api.mediaReadRange(file.file, file.token, p, Math.min(end, p + MAX_RANGE));
          if (!result || !result.ok) throw new Error((result && result.error) || 'Не получилось прочитать часть файла.');
          parts.push(new Uint8Array(result.data));
        }
        if (parts.length === 1) return parts[0];
        var out = new Uint8Array(length), offset = 0;
        parts.forEach(function (part) { out.set(part, offset); offset += part.length; });
        return out;
      }
    });
    var input = new media.Input({ source: source, formats: media.ALL_FORMATS });
    try {
      var track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) throw new Error('Этот формат звука не поддерживает чтение по частям.');
      var duration = await input.computeDuration();
      if (!(duration > 0) || !isFinite(duration)) throw new Error('Не удалось определить длину записи.');
      return new Reader(input, new media.AudioBufferSink(track), duration);
    } catch (e) { input.dispose(); throw e; }
  }
  function Reader(input, sink, duration) { this.input = input; this.sink = sink; this.duration = duration; }
  Reader.prototype.close = function () { this.input.dispose(); };
  Reader.prototype.scan = async function (onProgress, stopped) {
    var levels = [], rate = 0, frameSize = 0, cursor = 0, count = 0, sum = 0;
    function nextFrameSize() { return Math.round((levels.length + 1) * FRAME * rate) - Math.round(levels.length * FRAME * rate); }
    function add(value) {
      sum += value * value;
      if (++count === frameSize) { levels.push(10 * Math.log10(sum / frameSize + 1e-12)); count = 0; sum = 0; frameSize = nextFrameSize(); }
      cursor++;
    }
    function silence(length) {
      while (length && count) { add(0); length--; }
      while (length >= frameSize) { levels.push(-120); cursor += frameSize; length -= frameSize; frameSize = nextFrameSize(); }
      while (length--) add(0);
    }
    for await (var item of this.sink.buffers()) {
      if (stopped()) throw new Error('stopped');
      var buf = item.buffer;
      if (!rate) { rate = buf.sampleRate; frameSize = nextFrameSize(); }
      if (buf.sampleRate !== rate) throw new Error('Частота звука в записи меняется.');
      var start = Math.round(item.timestamp * rate), gap = start - cursor;
      if (gap > 0) {
        if (gap > rate * 3600) throw new Error('В записи слишком большой промежуток без звука.');
        silence(gap);
      }
      var skip = Math.max(0, -gap), channels = [];
      for (var c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
      for (var i = skip; i < buf.length; i++) {
        var value = 0;
        for (var ch = 0; ch < channels.length; ch++) value += channels[ch][i];
        add(value / channels.length);
      }
      if (onProgress) onProgress(Math.min(1, cursor / rate / this.duration));
    }
    if (!rate) throw new Error('В записи нет звуковой дорожки.');
    return new Float32Array(levels);
  };
  // Decode at most 30 seconds at a time, then resample into the small WAV needed by the service.
  Reader.prototype.wav = async function (a, b, stopped) {
    var total = Math.max(1, Math.ceil((b - a) * RATE)), pcm = new Float32Array(total);
    for (var begin = a; begin < b; begin += 30) {
      if (stopped && stopped()) throw new Error('stopped');
      var end = Math.min(b, begin + 30), segment = null, rate = 0, written = 0;
      for await (var item of this.sink.buffers(begin, end)) {
        if (stopped && stopped()) throw new Error('stopped');
        var buf = item.buffer;
        if (!segment) {
          rate = buf.sampleRate;
          segment = new AudioBuffer({ numberOfChannels: 1, length: Math.max(1, Math.ceil((end - begin) * rate)), sampleRate: rate });
        }
        if (buf.sampleRate !== rate) throw new Error('Частота звука в записи меняется.');
        var srcStart = Math.max(0, Math.round((begin - item.timestamp) * rate));
        var dstStart = Math.max(0, Math.round((item.timestamp - begin) * rate));
        if (dstStart < written) { var overlap = written - dstStart; srcStart += overlap; dstStart += overlap; }
        var amount = Math.max(0, Math.min(buf.length - srcStart, segment.length - dstStart));
        if (!amount) continue;
        var dst = segment.getChannelData(0);
        for (var c = 0; c < buf.numberOfChannels; c++) {
          var src = buf.getChannelData(c);
          for (var i = 0; i < amount; i++) dst[dstStart + i] += src[srcStart + i] / buf.numberOfChannels;
        }
        written = dstStart + amount;
      }
      if (!segment) continue;
      var n = Math.min(total - Math.round((begin - a) * RATE), Math.ceil((end - begin) * RATE));
      if (n <= 0) continue;
      var off = new OfflineAudioContext(1, n, RATE), node = off.createBufferSource();
      node.buffer = segment; node.connect(off.destination); node.start();
      var resampled = await off.startRendering();
      pcm.set(resampled.getChannelData(0), Math.round((begin - a) * RATE));
    }
    var wav = new ArrayBuffer(44 + total * 2), view = new DataView(wav);
    function str(pos, s) { for (var i = 0; i < s.length; i++) view.setUint8(pos + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, total * 2, true);
    for (var i = 0; i < total; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return wav;
  };
  window.transcriptionStream = { open: open };
})();
