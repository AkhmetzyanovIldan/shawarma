import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { products, extras, priceCart, validateTelegram, paymentMatches } from './domain.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
const production=process.env.NODE_ENV==='production';
const port=Number(process.env.PORT||3000);
const origin=process.env.APP_URL||`http://localhost:${port}`;
const mode=process.env.PAYMENT_MODE||'demo';
const adminPassword=process.env.ADMIN_PASSWORD||(production?'':'kruti-local-2026');
if(!['demo','yookassa_test','yookassa_live'].includes(mode)) throw new Error('Invalid PAYMENT_MODE');
if(production && (!origin.startsWith('https://') || adminPassword.length<16 || !process.env.TELEGRAM_BOT_TOKEN || mode==='demo')) throw new Error('Production requires HTTPS APP_URL, strong ADMIN_PASSWORD, TELEGRAM_BOT_TOKEN and YooKassa mode');
if(mode!=='demo' && (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY)) throw new Error('Set YooKassa credentials');
if(mode==='yookassa_live' && (process.env.RECEIPTS_CONFIGURED!=='true' || !/^[1-9]\d*$/.test(process.env.RECEIPT_VAT_CODE||'') || !/^[1-6]$/.test(process.env.RECEIPT_TAX_SYSTEM_CODE||''))) throw new Error('Configure fiscal receipt settings before live payments');
const data=path.resolve(process.env.DATA_DIR||'data'); mkdirSync(data,{recursive:true});
const db=new DatabaseSync(path.join(data,'kruti.sqlite'));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,request_key)); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, owner TEXT, role TEXT, expires INTEGER); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const digest=value=>createHash('sha256').update(value).digest('hex');
const readOrder=id=>{const row=db.prepare('SELECT body FROM orders WHERE id=?').get(id);return row?JSON.parse(row.body):null;};
const saveOrder=o=>db.prepare('UPDATE orders SET body=? WHERE id=?').run(JSON.stringify(o),o.id);
const allOrders=()=>db.prepare('SELECT body FROM orders ORDER BY rowid DESC LIMIT 500').all().map(r=>JSON.parse(r.body));
const unavailable=()=>JSON.parse(db.prepare("SELECT value FROM settings WHERE key='unavailable'").get()?.value||'[]');
const setting=(key,fallback)=>JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value??JSON.stringify(fallback));
const setSetting=(key,value)=>db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value));
const limits=new Map();
setInterval(()=>{limits.clear();db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());},60000).unref();
function limit(req,key,max){const id=`${req.socket.remoteAddress}:${key}`;const n=(limits.get(id)||0)+1;limits.set(id,n);if(n>max)fail(429,'Слишком много попыток. Подождите минуту.');}
function fail(status,message){throw Object.assign(new Error(message),{status});}
function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));}
async function body(req){let s='';for await(const c of req){s+=c;if(s.length>24000)fail(413,'Слишком большой запрос');}try{return s?JSON.parse(s):{};}catch{fail(400,'Некорректный JSON');}}
function session(req,role='customer'){const cookie=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith(`${role}=`))?.split('=')[1];return cookie?db.prepare('SELECT * FROM sessions WHERE token=? AND role=? AND expires>?').get(digest(cookie),role,Date.now()):null;}
function createSession(res,owner,role){const token=randomBytes(32).toString('hex');const ttl=role==='admin'?8*3600:7*86400;db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),owner,role,Date.now()+ttl*1000);res.setHeader('Set-Cookie',`${role}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttl}${production?'; Secure':''}`);return owner;}
function customer(req){const s=session(req);if(!s)fail(401,production?'Откройте приложение через Telegram':'Обновите страницу');return s.owner;}
function admin(req){if(!session(req,'admin'))fail(401,'Войдите в админку');}
function ownOrder(req,id){const o=readOrder(id);if(!o||o.owner!==customer(req))fail(404,'Заказ не найден');return o;}
function publicOrder(o,isAdmin=false){const {owner,requestKey,paymentId,paymentKey,...rest}=o;return {...rest,pickupCode:isAdmin?undefined:(o.paid&&o.status!=='collected'?o.pickupCode:undefined)};}
const auth='Basic '+Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
async function yoo(endpoint,options={}){const response=await fetch(`https://api.yookassa.ru/v3/${endpoint}`,{...options,headers:{Authorization:auth,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});if(!response.ok)fail(502,'ЮKassa временно недоступна. Попробуйте ещё раз.');return response.json();}
async function refreshPayment(o){if(!o.paymentId||o.paid||mode==='demo')return o;const p=await yoo(`payments/${encodeURIComponent(o.paymentId)}`);o=readOrder(o.id);if(o.paid)return o;if(paymentMatches(p,o,mode)){o.paid=true;o.status='paid';o.pickupCode=String(randomInt(100000,1000000));o.paidAt=new Date().toISOString();saveOrder(o);}else if(p.status==='canceled'){o.status='canceled';saveOrder(o);}return o;}
const paymentLocks=new Map();
async function paymentFor(o){
  if(paymentLocks.has(o.id))return paymentLocks.get(o.id);
  const work=(async()=>{
    if(o.paymentId)return o;
    const payload={amount:{value:o.total.toFixed(2),currency:'RUB'},capture:true,confirmation:{type:'redirect',return_url:`${origin}/?order=${o.id}`},description:`КРУТИ · заказ ${o.number}`,metadata:{order_id:o.id}};
    if(mode==='yookassa_live')payload.receipt={customer:{email:o.email},tax_system_code:Number(process.env.RECEIPT_TAX_SYSTEM_CODE),items:o.items.map(i=>({description:i.name+(i.size==='large'?' XL':''),quantity:i.quantity.toFixed(2),amount:{value:i.unitPrice.toFixed(2),currency:'RUB'},vat_code:Number(process.env.RECEIPT_VAT_CODE),payment_mode:'full_payment',payment_subject:'commodity'}))};
    const p=await yoo('payments',{method:'POST',headers:{'Idempotence-Key':o.paymentKey},body:JSON.stringify(payload)});
    if(p.test!==(mode==='yookassa_test'))fail(502,'Режим магазина не совпадает с режимом приложения');
    const url=new URL(p.confirmation?.confirmation_url||'https://invalid.local');
    if(url.protocol!=='https:'||!/(^|\.)(yookassa\.ru|yoomoney\.ru)$/.test(url.hostname))fail(502,'ЮKassa не вернула ссылку на оплату');
    o.paymentId=p.id;o.paymentUrl=url.href;saveOrder(o);return o;
  })();paymentLocks.set(o.id,work);try{return await work;}finally{paymentLocks.delete(o.id);}
}
async function handle(req,res){
  const url=new URL(req.url,origin), route=url.pathname;
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
  if(route.startsWith('/api/')){
    limit(req,'api',500);
    if(!['GET','HEAD'].includes(req.method)&&route!=='/api/payments/webhook'&&req.headers.origin!==origin)fail(403,'Недопустимый источник запроса');
    if(route==='/api/health')return json(res,200,{ok:true});
    if(route==='/api/catalog'&&req.method==='GET')return json(res,200,{products,extras,unavailable:unavailable(),acceptingOrders:setting('acceptingOrders',true),mode,telegramRequired:production});
    if(route==='/api/session'&&req.method==='POST'){
      const b=await body(req);let owner=session(req)?.owner;
      if(b.initData){let user;try{user=validateTelegram(b.initData,process.env.TELEGRAM_BOT_TOKEN||'');}catch(e){fail(401,e.message);}owner=`tg:${user.id}`;}
      else if(production&&!owner)fail(401,'Откройте приложение через Telegram');
      owner=owner||`guest:${randomUUID()}`;createSession(res,owner,'customer');return json(res,200,{ok:true});
    }
    if(route==='/api/orders'&&req.method==='GET'){const owner=customer(req);return json(res,200,allOrders().filter(o=>o.owner===owner).map(o=>publicOrder(o)));}
    if(route==='/api/orders'&&req.method==='POST'){
      limit(req,'orders',25);const owner=customer(req),b=await body(req);
      if(!/^[a-zA-Z0-9-]{16,80}$/.test(b.requestKey||''))fail(400,'Некорректный ключ заказа');
      const old=db.prepare('SELECT body FROM orders WHERE owner=? AND request_key=?').get(owner,b.requestKey);
      if(old)return json(res,200,publicOrder(JSON.parse(old.body)));
      if(!setting('acceptingOrders',true))fail(409,'Приём заказов временно приостановлен');
      let items;try{items=priceCart(b.items,unavailable());}catch(e){fail(400,e.message);}
      if(!['asap','15','30'].includes(b.pickup||'asap'))fail(400,'Проверьте время получения');
      const total=items.reduce((s,i)=>s+i.unitPrice*i.quantity,0);if(total>50000)fail(400,'Сумма заказа слишком большая');
      const email=String(b.email||'').trim();if(mode==='yookassa_live'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Укажите email для чека');
      const o={id:randomUUID(),owner,requestKey:b.requestKey,paymentKey:randomUUID(),number:100+Number(db.prepare('SELECT COUNT(*) n FROM orders').get().n)+1,items,total,email:email.slice(0,254),note:String(b.note||'').slice(0,240),pickup:b.pickup||'asap',status:'pending',paid:false,mode,createdAt:new Date().toISOString()};
      db.prepare('INSERT INTO orders VALUES(?,?,?,?)').run(o.id,owner,o.requestKey,JSON.stringify(o));return json(res,201,publicOrder(o));
    }
    const orderRoute=route.match(/^\/api\/orders\/([a-f0-9-]+)(?:\/(payment|demo-pay|refresh))?$/);
    if(orderRoute){let o=ownOrder(req,orderRoute[1]);const action=orderRoute[2];
      if(!action&&req.method==='GET')return json(res,200,publicOrder(o));
      if(req.method==='POST'&&action==='payment'){
        if(o.status==='canceled')fail(409,'Платёж отменён. Создайте новый заказ.');
        if(mode==='demo')return json(res,200,{demo:true,order:publicOrder(o)});
        o=await paymentFor(o);return json(res,200,{url:o.paymentUrl,order:publicOrder(o)});
      }
      if(req.method==='POST'&&action==='demo-pay'){
        if(production||mode!=='demo')fail(404,'Не найдено');
        if(!o.paid){o.paid=true;o.status='paid';o.pickupCode=String(randomInt(100000,1000000));o.paidAt=new Date().toISOString();saveOrder(o);}return json(res,200,publicOrder(o));
      }
      if(req.method==='POST'&&action==='refresh'){limit(req,'refresh',30);return json(res,200,publicOrder(await refreshPayment(o)));}
    }
    if(route==='/api/payments/webhook'&&req.method==='POST'){
      if(mode==='demo')return json(res,200,{ok:true});const b=await body(req);
      if(!['payment.succeeded','payment.canceled'].includes(b.event))return json(res,200,{ok:true});
      const id=b.object?.id;if(typeof id!=='string'||id.length>100)fail(400,'Некорректный платёж');
      const o=allOrders().find(o=>o.paymentId===id);if(!o)return json(res,200,{ok:true});
      await refreshPayment(o);return json(res,200,{ok:true});
    }
    if(route==='/api/admin/login'&&req.method==='POST'){
      limit(req,'login',8);const b=await body(req);if(!timingSafeEqual(Buffer.from(digest(String(b.password||'')),'hex'),Buffer.from(digest(adminPassword),'hex')))fail(401,'Неверный пароль');
      createSession(res,'admin','admin');return json(res,200,{ok:true});
    }
    if(route.startsWith('/api/admin/')){
      admin(req);
      if(route==='/api/admin/logout'&&req.method==='POST'){const s=session(req,'admin');db.prepare('DELETE FROM sessions WHERE token=?').run(s.token);res.setHeader('Set-Cookie','admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return json(res,200,{ok:true});}
      if(route==='/api/admin/orders'&&req.method==='GET')return json(res,200,allOrders().map(o=>publicOrder(o,true)));
      if(route==='/api/admin/settings'&&req.method==='POST'){const b=await body(req);if(typeof b.acceptingOrders==='boolean')setSetting('acceptingOrders',b.acceptingOrders);if(Array.isArray(b.unavailable)&&b.unavailable.every(id=>products.some(p=>p.id===id)))setSetting('unavailable',[...new Set(b.unavailable)]);return json(res,200,{ok:true});}
      const match=route.match(/^\/api\/admin\/orders\/([a-f0-9-]+)$/);
      if(match&&req.method==='POST'){
        const o=readOrder(match[1]);if(!o)fail(404,'Заказ не найден');const b=await body(req);
        if(!o.paid)fail(409,'Заказ ещё не оплачен');
        if(b.action==='prepare'&&o.status==='paid')o.status='preparing';
        else if(b.action==='ready'&&o.status==='preparing')o.status='ready';
        else if(b.action==='collect'&&o.status==='ready'){
          limit(req,`pickup:${o.id}`,5);if(String(b.code)!==o.pickupCode)fail(400,'Код не совпадает. Попросите покупателя открыть заказ.');o.status='collected';o.pickupCode=null;o.collectedAt=new Date().toISOString();
        }else fail(409,'Действие недоступно для этого статуса');
        saveOrder(o);return json(res,200,publicOrder(o,true));
      }
    }
    fail(404,'Не найдено');
  }
  if(!['GET','HEAD'].includes(req.method))fail(405,'Метод недоступен');
  let file;try{file=path.resolve(root,'.'+decodeURIComponent(route));}catch{fail(400,'Некорректный путь');}
  if(file!==root&&!file.startsWith(root+path.sep))fail(403,'Доступ запрещён');
  if(route==='/'||route==='/admin')file=path.join(root,'index.html');
  const ext=path.extname(file),types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2','.ttf':'font/ttf'};
  if(!types[ext])fail(404,'Файл не найден');
  let content;try{content=readFileSync(file);}catch{fail(404,'Файл не найден');}
  res.writeHead(200,{'Content-Type':types[ext],'Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600'});res.end(req.method==='HEAD'?undefined:content);
}
export const server=http.createServer((req,res)=>{handle(req,res).catch(e=>{if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'Не удалось выполнить действие. Попробуйте ещё раз.'});else res.end();if(!e.status)console.error(e.message);});});
server.listen(port,production?'0.0.0.0':'127.0.0.1',()=>console.log(`КРУТИ running at ${origin} · ${mode}`));
