import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const BOT = process.env.BOT_TOKEN, APP_URL = process.env.APP_URL;
const PORT = process.env.PORT || 3000;
const TZ = +(process.env.TZ_OFFSET || 5);      // Tashkent = UTC+5
const HOUR = +(process.env.REMIND_HOUR || 9);  // reminders from 09:00 local time
if (!BOT || !APP_URL) { console.error('Set BOT_TOKEN and APP_URL'); process.exit(1); }

const db = new DatabaseSync(process.env.DB_PATH || 'data.db');
db.exec(`create table if not exists items(id integer primary key autoincrement,uid integer,name text,day integer,amount real);
create table if not exists paid(item_id integer,ym text,primary key(item_id,ym));
create table if not exists sent(item_id integer,ym text,kind text,primary key(item_id,ym,kind));`);

const tg = (m, b) => fetch(`https://api.telegram.org/bot${BOT}/${m}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

// Проверка подписи Telegram: так мы узнаём, кто пользователь
function auth(init) {
  const p = new URLSearchParams(init), hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  if (crypto.createHmac('sha256', key).update(str).digest('hex') !== hash) return null;
  if (Date.now() / 1000 - +p.get('auth_date') > 7 * 86400) return null;
  return JSON.parse(p.get('user')).id;
}

const j = (res, c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const body = req => new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => r(s ? JSON.parse(s) : {})); });

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (!u.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync('public/index.html'));
    }
    const uid = auth(req.headers['x-init'] || '');
    if (!uid) return j(res, 401, {});
    const p = u.pathname.slice(5);
    if (req.method === 'GET' && p === 'data') {
      const ym = u.searchParams.get('ym');
      return j(res, 200, {
        items: db.prepare('select id,name,day,amount from items where uid=?').all(uid),
        paid: db.prepare('select item_id from paid where ym=? and item_id in (select id from items where uid=?)').all(ym, uid).map(r => r.item_id)
      });
    }
    if (req.method === 'POST' && p === 'items') {
      const b = await body(req), name = String(b.name || '').slice(0, 60), day = Math.min(31, Math.max(1, +b.day | 0)), amount = +b.amount || 0;
      if (b.id) db.prepare('update items set name=?,day=?,amount=? where id=? and uid=?').run(name, day, amount, +b.id, uid);
      else db.prepare('insert into items(uid,name,day,amount) values(?,?,?,?)').run(uid, name, day, amount);
      return j(res, 200, {});
    }
    if (req.method === 'DELETE' && p.startsWith('items/')) {
      const id = +p.slice(6);
      db.prepare('delete from items where id=? and uid=?').run(id, uid);
      db.prepare('delete from paid where item_id=?').run(id);
      return j(res, 200, {});
    }
    if (req.method === 'POST' && p === 'paid') {
      const b = await body(req);
      if (!db.prepare('select 1 from items where id=? and uid=?').get(+b.id, uid)) return j(res, 404, {});
      if (b.paid) db.prepare('insert or ignore into paid values(?,?)').run(+b.id, String(b.ym));
      else db.prepare('delete from paid where item_id=? and ym=?').run(+b.id, String(b.ym));
      return j(res, 200, {});
    }
    j(res, 404, {});
  } catch (e) { console.error(e); j(res, 500, {}); }
}).listen(PORT, () => console.log('Listening on', PORT));

// Бот: /start и кнопка «Оплачено» прямо в напоминании
async function poll() {
  let off = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset: off, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      for (const u of r.result || []) {
        off = u.update_id + 1;
        if (u.message?.text?.startsWith('/start'))
          await tg('sendMessage', { chat_id: u.message.chat.id, text: 'Привет! Открой приложение и добавь свои платежи. Я буду напоминать о сроках.',
            reply_markup: { inline_keyboard: [[{ text: 'Открыть платежи', web_app: { url: APP_URL } }]] } });
        const c = u.callback_query;
        if (c?.data?.startsWith('p:')) {
          const [, id, ym] = c.data.split(':');
          if (db.prepare('select 1 from items where id=? and uid=?').get(+id, c.from.id)) {
            db.prepare('insert or ignore into paid values(?,?)').run(+id, ym);
            await tg('editMessageText', { chat_id: c.message.chat.id, message_id: c.message.message_id, text: '✅ ' + c.message.text + ' — оплачено' });
          }
          await tg('answerCallbackQuery', { callback_query_id: c.id, text: 'Отмечено как оплачено' });
        }
      }
    } catch (e) { await new Promise(r => setTimeout(r, 5000)); }
  }
}

// Напоминания: за 3 дня, в день оплаты, и каждый день после просрочки
function remind() {
  const n = new Date(Date.now() + TZ * 36e5);
  if (n.getUTCHours() < HOUR) return;
  const ds = n.toISOString().slice(0, 10), ym = ds.slice(0, 7), td = n.getUTCDate();
  const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate();
  for (const it of db.prepare('select * from items').all()) {
    if (db.prepare('select 1 from paid where item_id=? and ym=?').get(it.id, ym)) continue;
    const diff = Math.min(it.day, last) - td;
    const kind = diff === 3 ? 'd3' : diff === 0 ? 'd0' : diff < 0 ? 'late' + ds : null;
    if (!kind || db.prepare('select 1 from sent where item_id=? and ym=? and kind=?').get(it.id, ym, kind)) continue;
    db.prepare('insert into sent values(?,?,?)').run(it.id, ym, kind);
    const t = diff > 0 ? `⏰ Через ${diff} дн.` : diff === 0 ? '📅 Сегодня срок' : `❗ Просрочено на ${-diff} дн.`;
    tg('sendMessage', { chat_id: it.uid, text: `${t}: ${it.name} — ${Number(it.amount).toLocaleString('ru-RU')} сум`,
      reply_markup: { inline_keyboard: [[{ text: '✓ Оплачено', callback_data: `p:${it.id}:${ym}` }]] } });
  }
}
tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Платежи', web_app: { url: APP_URL } } });
setInterval(remind, 6e4); remind(); poll();
