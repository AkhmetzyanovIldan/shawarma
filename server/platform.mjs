import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';

export function passwordHash(password) {
  const salt=randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
export function passwordMatches(password, stored) {
  try {const [salt,hash]=stored.split(':');return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(hash,'hex'));}catch{return false;}
}
export const defaultStore={name:'КРУТИ',city:'Санкт-Петербург',address:'Демо-точка на Лиговском',phone:'',timezone:'Europe/Moscow',open:'00:00',close:'00:00',days:[0,1,2,3,4,5,6],leadMinutes:15,checkoutMinutes:15,capacity:30,legalName:'',inn:'',supportEmail:''};
export function validateStore(input) {
  const result={...defaultStore,...input};
  for(const [key,max] of Object.entries({name:60,city:80,address:200,phone:40,legalName:200,inn:12,supportEmail:254})){
    if(typeof result[key]!=='string'||result[key].length>max)throw new Error(`Проверьте поле ${key}`);
    result[key]=result[key].trim();
  }
  if(!result.name||!result.city||!result.address)throw new Error('Название, город и адрес обязательны');
  try{new Intl.DateTimeFormat('ru',{timeZone:result.timezone}).format();}catch{throw new Error('Некорректный часовой пояс');}
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(result.open)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(result.close))throw new Error('Время должно быть в формате ЧЧ:ММ');
  if(!Array.isArray(result.days)||result.days.some(d=>!Number.isInteger(d)||d<0||d>6))throw new Error('Проверьте дни недели');
  for(const [key,min,max] of [['leadMinutes',5,120],['checkoutMinutes',5,30],['capacity',1,500]])if(!Number.isInteger(result[key])||result[key]<min||result[key]>max)throw new Error(`Проверьте поле ${key}: ${min}–${max}`);
  if(result.inn&&!/^(\d{10}|\d{12})$/.test(result.inn))throw new Error('ИНН должен содержать 10 или 12 цифр');
  if(result.supportEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.supportEmail))throw new Error('Проверьте email поддержки');
  return result;
}
export function isOpen(store, now=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:store.timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday), time=`${parts.hour}:${parts.minute}`;
  if(store.open===store.close)return store.days.includes(day);
  if(store.open<store.close)return store.days.includes(day)&&time>=store.open&&time<store.close;
  return (time>=store.open&&store.days.includes(day))||(time<store.close&&store.days.includes((day+6)%7));
}
export function validateCatalog(input){
  if(!input||!Array.isArray(input.products)||!Array.isArray(input.extras)||input.products.length<1||input.products.length>100||input.extras.length>30)throw new Error('Меню: 1–100 блюд, до 30 добавок');
  const clean=(items,isProduct)=>{
    const seen=new Set();return items.map(item=>{
      if(!/^[a-z0-9-]{1,50}$/.test(item.id||'')||seen.has(item.id))throw new Error('Идентификаторы должны быть уникальными');seen.add(item.id);
      if(typeof item.name!=='string'||!item.name.trim()||item.name.length>80||!Number.isInteger(item.price)||item.price<1||item.price>10000)throw new Error('Проверьте название и цену');
      const result={id:item.id,name:item.name.trim(),price:item.price};
      if(!isProduct)return {...result,icon:'＋'};
      if(!['shawarma','veggie','sides','drinks'].includes(item.category)||!Number.isInteger(item.weight)||item.weight<1||item.weight>5000||!['classic.webp','cheese.webp','spicy.webp','falafel.webp','fries.webp','lemonade.webp'].includes(item.image))throw new Error('Проверьте категорию, вес и фото');
      for(const key of ['description','ingredients','allergens','badge']){if(typeof item[key]!=='string'||item[key].length>(key==='badge'?30:500))throw new Error('Проверьте описание, состав и аллергены');result[key]=item[key];}
      return {...result,weight:item.weight,category:item.category,image:item.image,color:'green'};
    });
  };
  return {products:clean(input.products,true),extras:clean(input.extras,false)};
}
export function setupPlatform(db, adminPassword) {
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE INDEX IF NOT EXISTS orders_owner ON orders(owner);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_payment ON orders(json_extract(body,'$.paymentId')) WHERE json_extract(body,'$.paymentId') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS staff(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL, permission TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, order_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, error TEXT);
    CREATE TABLE IF NOT EXISTS webhook_inbox(id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, received_at INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,next_at);
    CREATE INDEX IF NOT EXISTS inbox_due ON webhook_inbox(processed,received_at);
    CREATE INDEX IF NOT EXISTS orders_created ON orders(json_extract(body,'$.createdAt'));
    CREATE INDEX IF NOT EXISTS orders_payment_check ON orders(json_extract(body,'$.lastPaymentCheck'));
  `);
  if(!db.prepare('PRAGMA table_info(webhook_inbox)').all().some(c=>c.name==='next_at'))db.exec('ALTER TABLE webhook_inbox ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('SELECT id FROM staff LIMIT 1').get())db.prepare('INSERT INTO staff VALUES(?,?,?,?,?,1)').run('admin','owner','Владелец',passwordHash(adminPassword),'owner');
  // A single server owns this SQLite file. Pending jobs survive process restarts.
  db.prepare("UPDATE jobs SET state='pending' WHERE state='running'").run();
  return {
    audit(actor,action,target='',detail={}){db.prepare('INSERT INTO audit(at,actor,action,target,detail) VALUES(?,?,?,?,?)').run(new Date().toISOString(),actor,action,target,JSON.stringify(detail));},
    staff(id){return db.prepare('SELECT id,username,name,permission,active FROM staff WHERE id=?').get(id);},
    createStaff(input){
      if(!/^[a-z0-9_.-]{3,40}$/.test(input.username||'')||typeof input.name!=='string'||!input.name.trim()||input.name.length>80||typeof input.password!=='string'||input.password.length<12||input.password.length>128||!['owner','manager','kitchen'].includes(input.permission))throw new Error('Логин: 3–40 латинских символов. Пароль: 12–128 символов. Проверьте имя и роль.');
      const id=randomUUID();db.prepare('INSERT INTO staff VALUES(?,?,?,?,?,1)').run(id,input.username,input.name.trim(),passwordHash(input.password),input.permission);return id;
    }
  };
}
