import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeStore } from '../server/platform.mjs';

test('A fresh installation starts with Vkus Vostoka without a local database',()=>{
  const db=new DatabaseSync(':memory:');
  try{initializeStore(db);const s=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='store'").get().value);
    assert.equal(s.name,'Вкус востока');assert.equal(s.city,'Москва');assert.equal(s.address,'ул. Академика Волгина, 1');
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
