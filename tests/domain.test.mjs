import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { priceCart, validateTelegram, paymentMatches } from '../server/domain.mjs';
test('Server prices extras and XL; ignores client-supplied prices',()=>{
  const [i]=priceCart([{id:'classic',quantity:2,size:'large',extras:['cheddar','carrot'],unitPrice:1}]);
  assert.equal(i.unitPrice,465);assert.equal(i.unitPrice*i.quantity,930);
});
test('Rejects unknown products, duplicate extras, invalid quantities and unavailable dishes',()=>{
  for(const item of [{id:'oops',quantity:1},{id:'classic',quantity:-1},{id:'classic',quantity:1.5},{id:'classic',quantity:1,extras:['cheddar','cheddar']},{id:'classic',quantity:1,extras:['free']},{id:'fries',quantity:1,size:'large'}])assert.throws(()=>priceCart([item]));
  assert.throws(()=>priceCart([{id:'classic',quantity:1}],['classic']));
});
function initData(token,date){const p=new URLSearchParams({auth_date:String(date),query_id:'test',user:JSON.stringify({id:12345,first_name:'Test'})});const check=[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');const secret=createHmac('sha256','WebAppData').update(token).digest();p.set('hash',createHmac('sha256',secret).update(check).digest('hex'));return p.toString();}
test('Telegram signature and freshness are verified',()=>{const token='test-token';const now=Date.now();const raw=initData(token,Math.floor(now/1000));assert.equal(validateTelegram(raw,token,now).id,12345);assert.throws(()=>validateTelegram(raw,'other-token',now));assert.throws(()=>validateTelegram(initData(token,Math.floor(now/1000)-3601),token,now));assert.throws(()=>validateTelegram(raw.replace('12345','54321'),token,now));});
test('Payment confirmation binds provider ID, amount, currency, order and test mode',()=>{const o={id:'order-1',paymentId:'pay-1',total:340};const p={id:'pay-1',status:'succeeded',paid:true,amount:{value:'340.00',currency:'RUB'},metadata:{order_id:'order-1'},test:true};assert.equal(paymentMatches(p,o,'yookassa_test'),true);for(const change of [{paid:false},{id:'other'},{metadata:{order_id:'other'}},{amount:{value:'1.00',currency:'RUB'}},{test:false},{status:'pending'}])assert.equal(paymentMatches({...p,...change},o,'yookassa_test'),false);});
