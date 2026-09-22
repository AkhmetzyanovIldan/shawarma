import http from 'node:http';
import { setupPlatform, defaultStore, validateStore, validateCatalog, isOpen, passwordMatches, passwordHash } from './platform.mjs';
import { createPayments } from './payments.mjs';
import { acquireDataLock, backupDatabase } from './operations.mjs';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, randomInt, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { products, extras, priceCart, validateTelegram } from './domain.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
const production=process.env.NODE_ENV==='production';
const port=Number(process.env.PORT||3000);
const origin=process.env.APP_URL||`http://localhost:${port}`;
const mode=process.env.PAYMENT_MODE||'demo';
const adminPassword=process.env.ADMIN_PASSWORD||(production?'':'kruti-local-2026');
if(!['demo','yookassa_test','yookassa_live'].includes(mode)) throw new Error('Invalid PAYMENT_MODE');
if(production && (!origin.startsWith('https://') || adminPassword.length<16 || !process.env.TELEGRAM_BOT_TOKEN || mode==='demo')) throw new Error('Production requires HTTPS APP_URL, strong ADMIN_PASSWORD, TELEGRAM_BOT_TOKEN and YooKassa mode');
if(mode!=='demo' && (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY)) throw new Error('Set YooKassa credentials');
if(mode==='yookassa_live'&&process.env.LIVE_LAUNCH_APPROVED!=='true')throw new Error('Live launch is blocked until merchant, fiscal flow, infrastructure and acceptance tests are approved. See docs/RELEASE.md');
if(mode==='yookassa_live' && (process.env.RECEIPTS_CONFIGURED!=='true' || !/^[1-9]\d*$/.test(process.env.RECEIPT_VAT_CODE||'') || !/^[1-6]$/.test(process.env.RECEIPT_TAX_SYSTEM_CODE||''))) throw new Error('Configure fiscal receipt settings before live payments');
const data=path.resolve(process.env.DATA_DIR||'data'); mkdirSync(data,{recursive:true});
const releaseLock=acquireDataLock(data);process.on('exit',releaseLock);
const db=new DatabaseSync(path.join(data,'kruti.sqlite'));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,request_key)); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, owner TEXT, role TEXT, expires INTEGER); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);');
const platform=setupPlatform(db,adminPassword);
if(mode==='yookassa_live'&&db.prepare("SELECT id FROM orders WHERE json_extract(body,'$.mode')!='yookassa_live' LIMIT 1").get())throw new Error('Use a separate clean DATA_DIR for live orders; demo/test data cannot be used in live mode');
let backupStatus={ok:false,at:null};
function scheduledBackup(){try{backupDatabase(db,path.join(data,'backups'));backupStatus={ok:true,at:new Date().toISOString()};}catch{backupStatus={ok:false,at:backupStatus.at};console.error('Database backup failed');}}
scheduledBackup();const backupTimer=setInterval(scheduledBackup,3600000);backupTimer.unref();
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const digest=value=>createHash('sha256').update(value).digest('hex');
const readOrder=id=>{const row=db.prepare('SELECT body FROM orders WHERE id=?').get(id);return row?JSON.parse(row.body):null;};
const saveOrder=o=>db.prepare('UPDATE orders SET body=? WHERE id=?').run(JSON.stringify(o),o.id);
const allOrders=()=>db.prepare("SELECT body FROM orders WHERE json_extract(body,'$.status') IN ('paid','preparing','ready','payment_review') OR rowid IN (SELECT rowid FROM orders ORDER BY rowid DESC LIMIT 1000) ORDER BY rowid DESC").all().map(r=>JSON.parse(r.body));
const unavailable=()=>JSON.parse(db.prepare("SELECT value FROM settings WHERE key='unavailable'").get()?.value||'[]');
const setting=(key,fallback)=>JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value??JSON.stringify(fallback));
const setSetting=(key,value)=>db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value));
const store=()=>setting('store',defaultStore);
const menu=()=>setting('catalog',null)?.products||products.map(p=>({...p,...setting('menu',{})[p.id]}));
const additions=()=>setting('catalog',null)?.extras||extras.map(p=>({...p,...setting('extras',{})[p.id]}));
const accepting=()=>setting('acceptingOrders',true)&&isOpen(store());
function checkoutAllowed(o){
  if(o.mode!==mode)fail(409,'Этот заказ создан в другом режиме оплаты. Создайте новый.');
  if(o.paid)return;
  if(!accepting())fail(409,'Точка закрыта или приём заказов приостановлен');
  if(o.status!=='pending'||Date.now()>Date.parse(o.expiresAt||'2999-01-01'))fail(409,'Время оплаты истекло. Соберите новый заказ.');
  if(o.items.some(i=>unavailable().includes(i.id)||!menu().some(p=>p.id===i.id)))fail(409,'Блюдо недоступно. Соберите новый заказ.');
}
const limits=new Map();
setInterval(()=>{limits.clear();db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());},60000).unref();
function limit(req,key,max){const identity=key==='login'?req.socket.remoteAddress:(session(req,'admin')?.token||session(req)?.token||req.socket.remoteAddress);const id=`${identity}:${key}`;const n=(limits.get(id)||0)+1;limits.set(id,n);if(n>max)fail(429,'Слишком много попыток. Подождите минуту.');}
function fail(status,message){throw Object.assign(new Error(message),{status});}
function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));}
async function body(req){let s='';const max=req.url==='/api/admin/settings'?256000:24000;for await(const c of req){s+=c;if(Buffer.byteLength(s)>max)fail(413,'Слишком большой запрос');}let result;try{result=s?JSON.parse(s):{};}catch{fail(400,'Некорректный JSON');}if(!result||typeof result!=='object'||Array.isArray(result))fail(400,'Ожидается объект JSON');return result;}
function session(req,role='customer'){const cookie=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith(`${role}=`))?.split('=')[1];return cookie?db.prepare('SELECT * FROM sessions WHERE token=? AND role=? AND expires>?').get(digest(cookie),role,Date.now()):null;}
function createSession(res,owner,role){const token=randomBytes(32).toString('hex');const ttl=role==='admin'?8*3600:7*86400;db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),owner,role,Date.now()+ttl*1000);res.setHeader('Set-Cookie',`${role}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttl}${production?'; Secure':''}`);return owner;}
function customer(req){const s=session(req);if(!s)fail(401,production?'Откройте приложение через Telegram':'Обновите страницу');return s.owner;}
function admin(req,permissions=['owner','manager','kitchen']){const sessionData=session(req,'admin');const person=sessionData&&platform.staff(sessionData.owner);if(!person?.active)fail(401,'Войдите в админку');if(!permissions.includes(person.permission))fail(403,'Недостаточно прав');return person;}
function ownOrder(req,id){const o=readOrder(id);if(!o||o.owner!==customer(req))fail(404,'Заказ не найден');return o;}
function publicOrder(o,isAdmin=false){const {owner,requestKey,paymentId,paymentKey,refundKey,email,...rest}=o;return {...rest,refundRequested:Boolean(refundKey),pickupCode:isAdmin?undefined:(o.paid&&o.status!=='collected'?o.pickupCode:undefined)};}
const auth='Basic '+Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
async function yoo(endpoint,options={}){const response=await fetch(`https://api.yookassa.ru/v3/${endpoint}`,{...options,headers:{Authorization:auth,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});if(!response.ok)fail(502,'ЮKassa временно недоступна. Попробуйте ещё раз.');return response.json();}
const payments=createPayments({db,mode,yoo,readOrder,saveOrder,audit:platform.audit,canAccept:o=>accepting()&&!o.items.some(i=>unavailable().includes(i.id)||!menu().some(p=>p.id===i.id))});
const refreshPayment=payments.refresh;
function receipt(o){return {customer:{email:o.email},tax_system_code:Number(process.env.RECEIPT_TAX_SYSTEM_CODE),items:o.items.map(i=>({description:i.name+(i.size==='large'?' XL':''),quantity:i.quantity.toFixed(2),amount:{value:i.unitPrice.toFixed(2),currency:'RUB'},vat_code:Number(process.env.RECEIPT_VAT_CODE),payment_mode:process.env.RECEIPT_PAYMENT_MODE||'full_prepayment',payment_subject:'commodity'}))};}
async function paymentFor(o){
  const payload={amount:{value:o.total.toFixed(2),currency:'RUB'},capture:true,confirmation:{type:'redirect',return_url:origin+'/?order='+o.id},description:store().name+' · заказ '+o.number,metadata:{order_id:o.id}};
  if(mode==='yookassa_live')payload.receipt=receipt(o);
  o=await payments.payment(o,payload);
  if(!o.paymentId)fail(503,'Проверяем результат создания платежа. Повторите через несколько секунд — новый платёж не создаётся.');
  return o;
}
const worker=setInterval(()=>{if(mode!=='demo')payments.tick().catch(()=>console.error('Payment worker failed'));},5000);worker.unref();
async function handle(req,res){
  const url=new URL(req.url,origin), route=url.pathname;
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
  if(route.startsWith('/api/')){
    if(route!=='/api/health'&&route!=='/api/payments/webhook')limit(req,'api',500);
    if(!['GET','HEAD'].includes(req.method)&&route!=='/api/payments/webhook'&&req.headers.origin!==origin)fail(403,'Недопустимый источник запроса');
    if(route==='/api/health'){db.prepare('SELECT 1').get();const ok=mode==='demo'||Date.now()-payments.heartbeat()<300000;return json(res,ok?200:503,{ok});}
    if(route==='/api/catalog'&&req.method==='GET')return json(res,200,{products:menu(),extras:additions(),store:store(),unavailable:unavailable(),acceptingOrders:accepting(),manuallyAccepting:setting('acceptingOrders',true),mode,telegramRequired:production});
    if(route==='/api/session'&&req.method==='POST'){
      const b=await body(req);let owner=session(req)?.owner;
      if(b.initData){let user;try{user=validateTelegram(b.initData,process.env.TELEGRAM_BOT_TOKEN||'');}catch(e){fail(401,e.message);}owner=`tg:${user.id}`;}
      else if(production&&!owner)fail(401,'Откройте приложение через Telegram');
      owner=owner||`guest:${randomUUID()}`;createSession(res,owner,'customer');return json(res,200,{ok:true});
    }
    if(route==='/api/orders'&&req.method==='GET'){const owner=customer(req);return json(res,200,db.prepare('SELECT body FROM orders WHERE owner=? ORDER BY rowid DESC LIMIT 200').all(owner).map(r=>publicOrder(JSON.parse(r.body))));}
    if(route==='/api/orders'&&req.method==='POST'){
      limit(req,'orders',25);const owner=customer(req),b=await body(req);
      if(!/^[a-zA-Z0-9-]{16,80}$/.test(b.requestKey||''))fail(400,'Некорректный ключ заказа');
      const old=db.prepare('SELECT body FROM orders WHERE owner=? AND request_key=?').get(owner,b.requestKey);
      if(old)return json(res,200,publicOrder(JSON.parse(old.body)));
      if(!accepting())fail(409,'Точка закрыта или приём заказов временно приостановлен');
      const occupied=Number(db.prepare("SELECT count(*) n FROM orders WHERE json_extract(body,'$.status') IN ('paid','preparing','ready','payment_review') OR (json_extract(body,'$.status')='pending' AND json_extract(body,'$.expiresAt')>?)").get(new Date().toISOString()).n);
      if(occupied>=store().capacity)fail(409,'Кухня загружена. Попробуйте чуть позже.');
      let items;try{items=priceCart(b.items,unavailable(),menu(),additions());}catch(e){fail(400,e.message);}
      if(!['asap','15','30'].includes(b.pickup||'asap'))fail(400,'Проверьте время получения');
      const total=items.reduce((s,i)=>s+i.unitPrice*i.quantity,0);if(total>50000)fail(400,'Сумма заказа слишком большая');
      const email=String(b.email||'').trim();if(mode==='yookassa_live'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Укажите email для чека');
      const o={id:randomUUID(),owner,requestKey:b.requestKey,paymentKey:randomUUID(),number:100+Number(db.prepare('SELECT COUNT(*) n FROM orders').get().n)+1,items,total,email:email.slice(0,254),note:String(b.note||'').slice(0,240),pickup:b.pickup||'asap',status:'pending',paid:false,mode,expiresAt:new Date(Date.now()+store().checkoutMinutes*60000).toISOString(),createdAt:new Date().toISOString()};
      db.prepare('INSERT INTO orders VALUES(?,?,?,?)').run(o.id,owner,o.requestKey,JSON.stringify(o));return json(res,201,publicOrder(o));
    }
    const orderRoute=route.match(/^\/api\/orders\/([a-f0-9-]+)(?:\/(payment|demo-pay|refresh))?$/);
    if(orderRoute){let o=ownOrder(req,orderRoute[1]);const action=orderRoute[2];
      if(!action&&req.method==='GET')return json(res,200,publicOrder(o));
      if(req.method==='POST'&&action==='payment'){
        checkoutAllowed(o);if(o.paid)return json(res,200,{paid:true,order:publicOrder(o)});
        if(mode==='demo')return json(res,200,{demo:true,order:publicOrder(o)});
        o=await paymentFor(o);return json(res,200,{url:o.paymentUrl,order:publicOrder(o)});
      }
      if(req.method==='POST'&&action==='demo-pay'){
        if(production||mode!=='demo')fail(404,'Не найдено');
        checkoutAllowed(o);if(!o.paid){o.paid=true;o.status='paid';o.pickupCode=String(randomInt(100000,1000000));o.paidAt=new Date().toISOString();saveOrder(o);}return json(res,200,publicOrder(o));
      }
      if(req.method==='POST'&&action==='refresh'){limit(req,'refresh',30);return json(res,200,publicOrder(await refreshPayment(o)));}
    }
    if(route==='/api/payments/webhook'&&req.method==='POST'){
      limit(req,'webhook',1000);if(mode==='demo')return json(res,200,{ok:true});const b=await body(req);
      if(!['payment.succeeded','payment.canceled'].includes(b.event))return json(res,200,{ok:true});
      const id=b.object?.id;if(typeof id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(id))fail(400,'Некорректный платёж');
      db.prepare('INSERT OR IGNORE INTO webhook_inbox(id,payment_id,received_at,processed) VALUES(?,?,?,0)').run(b.event+':'+id,id,Date.now());
      payments.tick().catch(()=>{});return json(res,200,{ok:true});
    }
    if(route==='/api/admin/login'&&req.method==='POST'){
      limit(req,'login',8);const b=await body(req);const person=db.prepare('SELECT * FROM staff WHERE username=?').get(String(b.username||'owner').toLowerCase());
      if(!person?.active||!passwordMatches(String(b.password||''),person.password))fail(401,'Неверный логин или пароль');
      createSession(res,person.id,'admin');platform.audit(person.id,'staff.login');return json(res,200,{ok:true});
    }
    if(route.startsWith('/api/admin/')){
      const actor=admin(req);
      if(route==='/api/admin/me'&&req.method==='GET')return json(res,200,actor);
      if(route==='/api/admin/payments/resolve'&&req.method==='POST'){admin(req,['owner']);const b=await body(req);try{await payments.resolve(String(b.operationId||''),String(b.providerId||''),actor.id);}catch(e){fail(409,e.message);}return json(res,200,{ok:true});}
      if(route==='/api/admin/summary'&&req.method==='GET'){
        const tz=store().timezone,today=new Date().toLocaleDateString('en-CA',{timeZone:tz});
        const recent=db.prepare("SELECT body FROM orders WHERE json_extract(body,'$.createdAt')>=?").all(new Date(Date.now()-48*3600000).toISOString()).map(r=>JSON.parse(r.body));
        const revenue=recent.filter(o=>o.paid&&new Date(o.createdAt).toLocaleDateString('en-CA',{timeZone:tz})===today).reduce((n,o)=>n+o.total-(o.refundedAmount||0),0);
        return json(res,200,{revenue,done:db.prepare("SELECT COUNT(*) n FROM orders WHERE json_extract(body,'$.status')='collected'").get().n});
      }
      if(route==='/api/admin/audit'&&req.method==='GET'){admin(req,['owner']);return json(res,200,db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all());}
      if(route==='/api/admin/operations'&&req.method==='GET'){admin(req,['owner','manager']);return json(res,200,{jobs:db.prepare('SELECT id,kind,order_id,state,attempts,error,created_at FROM jobs WHERE state!=? ORDER BY created_at LIMIT 100').all('done'),inbox:db.prepare('SELECT COUNT(*) n FROM webhook_inbox WHERE processed=0').get().n,workerAgeSeconds:Math.round((Date.now()-payments.heartbeat())/1000),database:'SQLite · один экземпляр',backup:backupStatus,mode});}
      if(route==='/api/admin/staff'){
        admin(req,['owner']);
        if(req.method==='GET')return json(res,200,db.prepare('SELECT id,username,name,permission,active FROM staff').all());
        if(req.method==='POST'){const b=await body(req);let id;try{id=platform.createStaff(b);}catch(e){fail(400,e.message.includes('UNIQUE')?'Логин уже занят':e.message);}platform.audit(actor.id,'staff.created',id);return json(res,201,{id});}
      }
      const staffRoute=route.match(/^\/api\/admin\/staff\/([a-z0-9-]+)$/);
      if(staffRoute&&req.method==='POST'){
        admin(req,['owner']);const b=await body(req),id=staffRoute[1];if(id===actor.id)fail(409,'Нельзя отключить собственную учётную запись');if(!platform.staff(id))fail(404,'Сотрудник не найден');
        admin(req,['owner']);if(b.password!==undefined&&(typeof b.password!=='string'||b.password.length<12||b.password.length>128))fail(400,'Пароль: 12–128 символов');
        if(typeof b.active==='boolean')db.prepare('UPDATE staff SET active=? WHERE id=?').run(b.active?1:0,id);
        if(b.password!==undefined){if(typeof b.password!=='string'||b.password.length<12||b.password.length>128)fail(400,'Пароль: 12–128 символов');db.prepare('UPDATE staff SET password=? WHERE id=?').run(passwordHash(b.password),id);}
        db.prepare("DELETE FROM sessions WHERE owner=? AND role='admin'").run(id);platform.audit(actor.id,'staff.updated',id);return json(res,200,{ok:true});
      }
      if(route==='/api/admin/logout'&&req.method==='POST'){const s=session(req,'admin');db.prepare('DELETE FROM sessions WHERE token=?').run(s.token);res.setHeader('Set-Cookie','admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return json(res,200,{ok:true});}
      if(route==='/api/admin/orders'&&req.method==='GET')return json(res,200,allOrders().map(o=>publicOrder(o,true)));
      if(route==='/api/admin/settings'&&req.method==='POST'){admin(req,['owner','manager']);const b=await body(req);db.exec('BEGIN IMMEDIATE');try{
        if(b.catalog){let value;try{value=validateCatalog(b.catalog);}catch(e){fail(400,e.message);}setSetting('catalog',value);setSetting('unavailable',unavailable().filter(id=>value.products.some(p=>p.id===id)));}
        if(b.store){let value;try{value=validateStore(b.store);}catch(e){fail(400,e.message);}setSetting('store',value);}
        for(const key of ['menu','extras'])if(b[key]){const list=key==='menu'?products:extras;const clean={};for(const [id,value] of Object.entries(b[key])){if(!list.some(p=>p.id===id)||typeof value.name!=='string'||!value.name.trim()||value.name.length>80||!Number.isInteger(value.price)||value.price<1||value.price>10000)fail(400,'Проверьте название и цену');clean[id]={name:value.name.trim(),price:value.price};}setSetting(key,clean);}
        platform.audit(actor.id,'settings.updated','store',{fields:Object.keys(b)});if(typeof b.acceptingOrders==='boolean')setSetting('acceptingOrders',b.acceptingOrders);if(Array.isArray(b.unavailable)&&b.unavailable.every(id=>menu().some(p=>p.id===id)))setSetting('unavailable',[...new Set(b.unavailable)]);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return json(res,200,{ok:true});}
      const match=route.match(/^\/api\/admin\/orders\/([a-f0-9-]+)$/);
      if(match&&req.method==='POST'){
        const b=await body(req);admin(req);const o=readOrder(match[1]);if(!o)fail(404,'Заказ не найден');if(o.mode!==mode)fail(409,'Заказ создан в другом режиме оплаты');
        if(b.action==='refund'){
          admin(req,['owner','manager']);if(typeof b.reason!=='string'||b.reason.trim().length<5)fail(400,'Укажите причину возврата');
          const payload={payment_id:o.paymentId,amount:{value:o.total.toFixed(2),currency:'RUB'},description:b.reason.slice(0,200)};if(mode==='yookassa_live')payload.receipt=receipt(o);
          let result;try{result=await payments.refund(o,payload,actor.id);}catch(e){fail(409,e.message);}return json(res,200,publicOrder(result,true));
        }
        if(b.action==='accept-late'&&o.status==='payment_review'&&!o.refundedAmount&&!o.refundKey){admin(req,['owner','manager']);o.status='paid';o.pickupCode=String(randomInt(100000,1000000));saveOrder(o);platform.audit(actor.id,'order.accept_late',o.id);return json(res,200,publicOrder(o,true));}
        if(!o.paid)fail(409,'Заказ ещё не оплачен');
        if(o.refundKey||o.refundedAmount>0)fail(409,'По заказу оформлен возврат');
        if(b.action==='prepare'&&o.status==='paid')o.status='preparing';
        else if(b.action==='ready'&&o.status==='preparing')o.status='ready';
        else if(b.action==='collect'&&o.status==='ready'){
          limit(req,`pickup:${o.id}`,5);if(String(b.code)!==o.pickupCode)fail(400,'Код не совпадает. Попросите покупателя открыть заказ.');o.status='collected';o.pickupCode=null;o.collectedAt=new Date().toISOString();
        }else fail(409,'Действие недоступно для этого статуса');
        saveOrder(o);platform.audit(actor.id,'order.'+b.action,o.id);return json(res,200,publicOrder(o,true));
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
  res.writeHead(200,{'Content-Type':types[ext],'Cache-Control':['.html','.js','.css'].includes(ext)?'no-cache':'public, max-age=3600'});res.end(req.method==='HEAD'?undefined:content);
}
export const server=http.createServer((req,res)=>{handle(req,res).catch(e=>{if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'Не удалось выполнить действие. Попробуйте ещё раз.'});else res.end();if(!e.status)console.error(e.message);});});
server.listen(port,production?'0.0.0.0':'127.0.0.1',()=>console.log(`КРУТИ running at ${origin} · ${mode}`));
function shutdown(){clearInterval(worker);clearInterval(backupTimer);server.close(()=>{db.close();releaseLock();process.exit(0);});setTimeout(()=>process.exit(1),20000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
