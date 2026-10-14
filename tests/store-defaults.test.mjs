import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeStore, migratePhotoMenu } from '../server/platform.mjs';

test('A fresh installation starts with Vkus Vostoka without a local database',()=>{
  const db=new DatabaseSync(':memory:');
  try{initializeStore(db);const s=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='store'").get().value);
    assert.equal(s.name,'Вкус востока');assert.equal(s.city,'Москва');assert.equal(s.address,'ул. Академика Волгина, 1');
  }finally{db.close();}
});
test('Photo menu migrates once, preserves custom dishes and historical order prices',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    initializeStore(db);
    db.exec('CREATE TABLE orders(id TEXT PRIMARY KEY,body TEXT)');
    const history=JSON.stringify({items:[{id:'classic',name:'Прежнее блюдо',unitPrice:290}],total:290});
    db.prepare('INSERT INTO orders VALUES(?,?)').run('old-order',history);
    const put=db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)');
    put.run('catalog',JSON.stringify({products:[{id:'classic',price:290},{id:'custom-pie',name:'Пирог',price:100}],extras:[]}));
    put.run('unavailable',JSON.stringify(['classic','spicy','custom-pie']));
    migratePhotoMenu(db);
    const read=key=>JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key).value);
    const catalog=read('catalog');
    assert.equal(catalog.products.length,13);assert.equal(catalog.products.find(p=>p.id==='classic').price,270);
    assert.equal(catalog.products.find(p=>p.id==='custom-pie').price,100);
    assert.deepEqual(catalog.extras.map(e=>e.price),[30,30]);
    assert.deepEqual(read('unavailable'),['classic','custom-pie']);
    assert.equal(read('store').open,read('store').close);assert.equal(read('store').days.length,7);assert.equal(read('store').hoursConfirmed,true);
    assert.equal(db.prepare('SELECT body FROM orders').get().body,history);
    catalog.products[0].price=299;put.run('catalog',JSON.stringify(catalog));
    put.run('store',JSON.stringify({...read('store'),open:'09:00',close:'22:00'}));
    migratePhotoMenu(db);
    assert.equal(read('catalog').products[0].price,299);assert.equal(read('store').open,'09:00');
  }finally{db.close();}
});
test('Old demo branding migrates once, preserving saved operating settings',()=>{
  const db=new DatabaseSync(':memory:');
  try{db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)');
    db.prepare('INSERT INTO settings VALUES(?,?)').run('store',JSON.stringify({name:'КРУТИ',city:'Санкт-Петербург',address:'Демо-точка на Лиговском',open:'10:00',close:'22:00',capacity:12}));
    initializeStore(db);const s=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='store'").get().value);
    assert.equal(s.name,'Вкус востока');assert.equal(s.city,'Москва');assert.equal(s.open,'10:00');assert.equal(s.capacity,12);
    const custom={...s,name:'Имя владельца',address:'Другой адрес'};db.prepare('UPDATE settings SET value=?').run(JSON.stringify(custom));initializeStore(db);
    assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='store'").get().value),custom);
  }finally{db.close();}
});
