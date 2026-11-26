// Malý server: posiela index.html a vytvára poznámky cez Gemini API.
// Kľúč je uložený len ako premenná prostredia na serveri (GEMINI_API_KEY).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ACCESS_CODE = process.env.ACCESS_CODE || ''; // voliteľné
const MAX_TEXT = 60000;
const LIMIT_PER_HOUR = 20;

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 3600000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > LIMIT_PER_HOUR;
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function buildPrompt(title, text) {
  return 'Si asistent pre študentov. Nižšie je prepis školskej hodiny (môže obsahovať chyby z rozpoznávania reči). ' +
    'Vytvor v slovenčine prehľadné študijné poznámky. Nič si nevymýšľaj, drž sa prepisu. ' +
    'Odpovedz IBA platným JSON bez markdownu v tvare: {"title":string,"summary":string (3-5 viet),"keyPoints":[string],' +
    '"notes":[{"heading":string,"points":[string]}],"terms":[{"term":string,"meaning":string}],' +
    '"todo":[string] (domáce úlohy, testy, termíny, ak ich učiteľ spomenul),"questions":[string] (3-5 otázok na opakovanie)}.\n\n' +
    'Názov hodiny: ' + (title || 'neuvedený') + '\n\nPREPIS:\n' + text;
}

async function notes(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return send(res, 429, { error: 'Príliš veľa požiadaviek, skús to neskôr.' });
  if (!KEY) return send(res, 500, { error: 'Server nemá nastavený GEMINI_API_KEY.' });
  if (ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) return send(res, 401, { error: 'Chýba prístupový kód.' });

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200000) return send(res, 413, { error: 'Prepis je príliš dlhý.' });
  }
  let data;
  try { data = JSON.parse(body); } catch { return send(res, 400, { error: 'Neplatná požiadavka.' }); }
  const text = String(data.text || '').slice(0, MAX_TEXT);
  if (text.trim().length < 40) return send(res, 400, { error: 'Prepis je príliš krátky.' });

  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(MODEL) + ':generateContent',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(String(data.title || '').slice(0, 200), text) }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );
    const j = await r.json();
    if (!r.ok) return send(res, 502, { error: (j.error && j.error.message) || 'Chyba služby Gemini.' });
    const out = j.candidates && j.candidates[0] && j.candidates[0].content.parts.map(p => p.text || '').join('');
    const parsed = JSON.parse(String(out).replace(/```json|```/g, '').trim());
    send(res, 200, parsed);
  } catch (e) {
    send(res, 500, { error: 'Nepodarilo sa spracovať odpoveď.' });
  }
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/notes') return notes(req, res);
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('Beží na porte ' + PORT));
