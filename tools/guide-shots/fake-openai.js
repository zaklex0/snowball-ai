// A fake OpenAI for taking the screenshots of the guides without spending money: answers transcription and
// responses requests the way the API does. Run: node tools/guide-shots/fake-openai.js  (port 8765)
// The app is started with OPENAI_BASE_URL=http://127.0.0.1:8765/v1.
// Texts of the demo pieces: piece-texts.json next to this file, [{ sec, text }] — a piece gets the text whose length
// in seconds is the nearest (pieces are 16 kHz 16-bit WAV, so seconds = bytes / 32000). FAKE_DELAY (ms) slows the
// transcription down so the progress bar can be photographed.
const http = require('http');
const fs = require('fs');
const path = require('path');
let n = 0;
const SUMMARY = {
  brief: 'Урок о том, как нейросеть помогает писать промты для видео: описать идею простыми словами, добавить картинки-референсы, указать модель — и получить готовый текст, который осталось проверить.',
  points: ['Идею описываем простыми словами', 'Картинки-референсы задают стиль', 'Указываем, для какой модели промт', 'Результат проверяем и запускаем генерацию']
};
function pieceText(bytes) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path.join(__dirname, 'piece-texts.json'), 'utf8')); } catch (e) { list = []; }
  const secs = (bytes - 300) / 32000;
  let best = null;
  list.forEach((t) => { if (!best || Math.abs(t.sec - secs) < Math.abs(best.sec - secs)) best = t; });
  console.log('piece', secs.toFixed(2), 's →', best && Math.abs(best.sec - secs) < 0.4 ? 'known' : 'unknown');
  return best && Math.abs(best.sec - secs) < 0.4 ? best.text : 'Фраза номер ' + (++n) + '.';
}
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/v1/responses')) {
      res.end(JSON.stringify({ id: 'resp_1', object: 'response', status: 'completed', output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(SUMMARY), annotations: [] }] }],
        usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 300, total_tokens: 1200 } }));
      return;
    }
    const text = pieceText(body.length);
    setTimeout(() => res.end(JSON.stringify({ text, usage: { type: 'tokens', input_tokens: 40, output_tokens: 8, total_tokens: 48 } })), Number(process.env.FAKE_DELAY) || 0);
  });
}).listen(8765, '127.0.0.1', () => console.log('fake openai on 8765'));
