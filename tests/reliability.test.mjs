import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { setupPlatform, defaultStore, isOpen, validateStore, validateCatalog, passwordMatches } from '../server/platform.mjs';
import { products, extras, priceCart } from '../server/domain.mjs';
import { createPayments } from '../server/payments.mjs';
import { backupDatabase } from '../server/operations.mjs';

function fixture(provider){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE orders(id TEXT PRIMARY KEY,owner TEXT,request_key TEXT,body TEXT); CREATE TABLE sessions(token TEXT,owner TEXT,role TEXT,expires INTEGER)');
  const platform=setupPlatform(db,'test-password-123');
  const readOrder=id=>{const row=db.prepare('SELECT body FROM orders WHERE id=?').get(id);return row&&JSON.parse(row.body);};
  const saveOrder=o=>db.prepare('UPDATE orders SET body=? WHERE id=?').run(JSON.stringify(o),o.id);
  const create=()=>{const o={id:randomUUID(),owner:'test',paymentKey:randomUUID(),number:101,total:290,items:[{id:'classic',name:'Классика',quantity:1,unitPrice:290}],status:'pending',paid:false,expiresAt:new Date(Date.now()+900000).toISOString()};db.prepare('INSERT INTO orders VALUES(?,?,?,?)').run(o.id,o.owner,randomUUID(),JSON.stringify(o));return o;};
  const build=()=>createPayments({db,mode:'yookassa_test',yoo:provider,readOrder,saveOrder,audit:platform.audit});
  return {db,create,readOrder,saveOrder,build};
}
const response=(o,extra={})=>({id:'provider-'+o.id,amount:{value:'290.00',currency:'RUB'},metadata:{order_id:o.id},test:true,status:'pending',paid:false,confirmation:{confirmation_url:'https://yookassa.ru/checkout/test'},...extra});
const payload=o=>({amount:{value:'290.00',currency:'RUB'},metadata:{order_id:o.id}});
test('Lost provider response survives restart and reuses the identical durable request',async()=>{
  let calls=0,order,requests=[];const f=fixture(async(endpoint,options)=>{requests.push(options);if(++calls===1)throw new Error('Response lost');return response(order);});
  try{order=f.create();const one=f.build();await one.payment(order,payload(order));assert.equal(f.readOrder(order.id).paymentId,undefined);
    f.db.prepare('UPDATE jobs SET next_at=0').run();const restarted=f.build();await restarted.payment(order,{amount:{value:'999.00',currency:'RUB'}});
    assert.equal(requests[0].headers['Idempotence-Key'],requests[1].headers['Idempotence-Key']);assert.equal(requests[0].body,requests[1].body);assert.ok(f.readOrder(order.id).paymentId);
  }finally{f.db.close();}
});
test('Expired idempotency window never blindly creates a new payment',async()=>{
  let count=0;const f=fixture(async()=>{count++;throw new Error('offline');});try{const o=f.create(),p=f.build();await p.payment(o,payload(o));f.db.prepare('UPDATE jobs SET created_at=?,next_at=0').run(Date.now()-24*3600000);await p.tick();assert.equal(count,1);assert.equal(f.db.prepare('SELECT state FROM jobs').get().state,'review');}finally{f.db.close();}
});
test('Early webhook binds verified payment to an old order outside latest 500 rows',async()=>{
  let old;const f=fixture(async()=>response(old,{status:'succeeded',paid:true}));try{
    old=f.create();for(let i=0;i<520;i++)f.create();
    const p=f.build();p.enqueue('payment',old.id,payload(old),old.paymentKey);f.db.prepare('UPDATE jobs SET next_at=?').run(Date.now()+600000);
    f.db.prepare('INSERT INTO webhook_inbox(id,payment_id,received_at,processed) VALUES(?,?,?,0)').run('event-1','provider-'+old.id,Date.now());await p.tick();
    assert.equal(f.readOrder(old.id).paid,true);assert.match(f.readOrder(old.id).pickupCode,/^\d{6}$/);assert.equal(f.db.prepare('SELECT processed FROM webhook_inbox').get().processed,1);
    const code=f.readOrder(old.id).pickupCode;await p.refresh(f.readOrder(old.id));assert.equal(f.readOrder(old.id).pickupCode,code);
  }finally{f.db.close();}
});
test('Mismatched provider amount cannot mark an order paid',async()=>{
  let o;const f=fixture(async()=>response(o,{amount:{value:'1.00',currency:'RUB'},status:'succeeded',paid:true}));try{o=f.create();await f.build().payment(o,payload(o));assert.equal(f.readOrder(o.id).paid,false);assert.equal(f.readOrder(o.id).paymentId,undefined);}finally{f.db.close();}
});
test('Changing payment mode never submits an old operation to another environment',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;throw new Error('must not call');});try{const o=f.create();o.mode='demo';f.saveOrder(o);await f.build().payment(o,payload(o));assert.equal(calls,0);assert.equal(f.db.prepare('SELECT state FROM jobs').get().state,'review');}finally{f.db.close();}
});
test('Late payment is held for staff review; full refund is idempotent',async()=>{
  let o,refunds=0;const f=fixture(async(endpoint)=>endpoint==='refunds'?(refunds++,{id:'refund-1',payment_id:'provider-'+o.id,status:'succeeded',amount:{value:'290.00',currency:'RUB'}}):response(o,{status:'succeeded',paid:true}));
  try{o=f.create();o.expiresAt=new Date(Date.now()-1000).toISOString();f.saveOrder(o);const p=f.build();await p.payment(o,payload(o));o=f.readOrder(o.id);assert.equal(o.status,'payment_review');assert.equal(o.pickupCode,null);
    await p.refund(o,{payment_id:o.paymentId,amount:{value:'290.00',currency:'RUB'}},'owner');await p.refund(f.readOrder(o.id),{},'owner');assert.equal(refunds,1);assert.equal(f.readOrder(o.id).status,'refunded');
  }finally{f.db.close();}
});
test('Overnight schedule uses opening day; invalid store input is rejected',()=>{
  const s={...defaultStore,days:[1],open:'22:00',close:'02:00',timezone:'UTC'};
  assert.equal(isOpen(s,new Date('2026-09-21T23:00:00Z')),true);assert.equal(isOpen(s,new Date('2026-09-22T01:00:00Z')),true);assert.equal(isOpen(s,new Date('2026-09-22T03:00:00Z')),false);assert.throws(()=>validateStore({...s,capacity:0}));
});
test('Custom menu has validated IDs and server-side pricing',()=>{
  const custom={...products[0],id:'custom',name:'Новое блюдо',price:499};const catalog=validateCatalog({products:[custom],extras});
  assert.equal(priceCart([{id:'custom',quantity:1,size:'regular',extras:['cheddar']}],[],catalog.products,catalog.extras)[0].unitPrice,549);
  assert.throws(()=>validateCatalog({products:[custom,custom],extras}));assert.throws(()=>validateCatalog({products:[{...custom,image:'../../.env'}],extras}));
});
test('Staff passwords are salted hashes and backup restores data while revoking sessions',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'kruti-restore-test-'));const f=fixture(async()=>{});
  try{const o=f.create();const hash=f.db.prepare('SELECT password FROM staff').get().password;assert.notEqual(hash,'test-password-123');assert.equal(passwordMatches('test-password-123',hash),true);assert.equal(passwordMatches('wrong',hash),false);
    f.db.exec("INSERT INTO sessions VALUES('session','test','customer',9999999999999)");const backup=backupDatabase(f.db,path.join(dir,'backups'));
    const destination=path.join(dir,'restored');const result=spawnSync(process.execPath,['scripts/restore.mjs',backup,destination],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
    const restored=new DatabaseSync(path.join(destination,'kruti.sqlite'));assert.equal(restored.prepare('SELECT id FROM orders').get().id,o.id);assert.equal(restored.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);restored.close();
    const second=spawnSync(process.execPath,['scripts/restore.mjs',backup,destination],{encoding:'utf8',windowsHide:true});assert.notEqual(second.status,0);
  }finally{f.db.close();rmSync(dir,{recursive:true,force:true});}
});
