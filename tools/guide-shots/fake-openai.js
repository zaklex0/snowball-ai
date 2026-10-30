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
    if (req.url.startsWith('/v1/responses') && body.toString('utf8').includes('"name":"recap"')) {
      // A call summary (the calendar guide): the same shape as RECAP_SCHEMA in main.js. Example people only.
      const day = new Date(Date.now() + 86400000), p2 = (v) => String(v).padStart(2, '0');
      const recap = { title: 'Мини-курс', who: 'Дима', brief: 'Решили сделать мини-курс коротким, до 30 минут, и собрать его с лёгким монтажом. Идеи готовит Гость, структуру — Дима. Следующий созвон завтра в 12:00.',
        decisions: ['Мини-курс делаем коротким, до 30 минут', 'Финальный ролик собираем с лёгким монтажом'],
        steps: [{ t: 'Подготовить идеи и примеры для мини-курса', who: 'Гость', mine: true, due: '' }, { t: 'Прислать концепт', who: 'Гость', mine: true, due: day.getFullYear() + '-' + p2(day.getMonth() + 1) + '-' + p2(day.getDate()) }, { t: 'Накидать структуру мини-курса', who: 'Дима', mine: false, due: '' }],
        meets: [{ t: 'Созвон по мини-курсу', date: day.getFullYear() + '-' + p2(day.getMonth() + 1) + '-' + p2(day.getDate()), from: '12:00', to: '12:30' }] };
      res.end(JSON.stringify({ id: 'resp_r', object: 'response', status: 'completed', output: [{ type: 'message', id: 'm2', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(recap), annotations: [] }] }],
        usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 300, total_tokens: 1200 } }));
      return;
    }
    if (req.url.startsWith('/v1/responses') && body.toString('utf8').includes('"name":"skill"')) {
      // A skill description («Промты» → «Скиллы»): the same shape as SKILL_SCHEMA in main.js.
      const reel = /рилс/i.test(body.toString('utf8'));
      const skill = reel ? { type: 'video', desc: 'Скилл помогает написать сценарий короткого вертикального ролика. Ассистент придумывает хук на первые две секунды, раскладывает ролик на три сцены и заканчивает призывом к действию. '
        + 'Для каждой сцены он пишет, что в кадре, что звучит и сколько она длится. Подходит для рилсов, шортсов и клипов в соцсетях. Пример: «сценарий рилса про утренний кофе».' } : { type: 'static', desc: 'Скилл помогает писать промты для картинок в одном узнаваемом стиле. Он задаёт порядок: сначала сюжет, потом свет, камера и детали. '
        + 'Внутри есть примеры готовых промтов и список слов, которых лучше избегать. Подходит, когда нужно сделать серию картинок, похожих друг на друга. '
        + 'Ассистент сам подставит ваши детали в шаблон. Пример: «сделай промт для обложки ролика про горы».' };
      setTimeout(() => res.end(JSON.stringify({ id: 'resp_s', object: 'response', status: 'completed', output: [{ type: 'message', id: 'm3', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(skill), annotations: [] }] }],
        usage: { input_tokens: 2400, input_tokens_details: { cached_tokens: 0 }, output_tokens: 700, total_tokens: 3100 } })), Number(process.env.FAKE_DELAY) || 600);
      return;
    }
    if (req.url.startsWith('/v1/responses')) {
      res.end(JSON.stringify({ id: 'resp_1', object: 'response', status: 'completed', output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(SUMMARY), annotations: [] }] }],
        usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 300, total_tokens: 1200 } }));
      return;
    }
    // The diarize model: phrases every 8 seconds, two voices in turn. Voices whose samples came with the request
    // (known_speaker_names) answer under those names, the others under letters — as the real API does.
    const latin = body.toString('latin1');
    const field = (name) => { const m = latin.match(new RegExp('name="' + name + '"\\r\\n(?:Content-Type: [^\\r]*\\r\\n)?\\r\\n([^\\r]*)')); return m ? Buffer.from(m[1], 'latin1').toString('utf8') : ''; };
    if (field('model') === 'gpt-4o-transcribe-diarize') {
      const known = [...latin.matchAll(/name="known_speaker_names(?:\[\])?"\r\n\r\n([^\r]*)/g)].map((m) => Buffer.from(m[1], 'latin1').toString('utf8'));
      const refs = (latin.match(/name="known_speaker_references/g) || []).length;
      const secs = (body.length - 300) / 32000, segments = [];
      for (let t = 0, i = 0; t + 3 < secs; t += 8, i++) {
        const who = i % 2 ? 'B' : 'A';
        segments.push({ id: 's' + i, type: 'transcript.text.segment', start: t + 0.3, end: Math.min(secs, t + 7), speaker: known[i % 2] || who, text: 'Реплика ' + (i + 1) + ' голосом ' + who + '.' });
      }
      console.log('diarize', secs.toFixed(1), 's, known names:', JSON.stringify(known), 'samples:', refs, 'lang:', field('language') || '-');
      res.end(JSON.stringify({ task: 'transcribe', duration: secs, text: segments.map((s) => s.text).join(' '), segments, usage: { type: 'duration', seconds: secs } }));
      return;
    }
    console.log('model', field('model'));
    const text = pieceText(body.length);
    setTimeout(() => res.end(JSON.stringify({ text, usage: { type: 'tokens', input_tokens: 40, output_tokens: 8, total_tokens: 48 } })), Number(process.env.FAKE_DELAY) || 0);
  });
}).listen(8765, '127.0.0.1', () => console.log('fake openai on 8765'));
