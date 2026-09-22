import { randomUUID, randomInt } from 'node:crypto';
import { paymentMatches } from './domain.mjs';

// Durable operations: persist the exact request before contacting the provider.
// Do not retry creation after the provider's 24h idempotency window.
export function createPayments({db,mode,yoo,readOrder,saveOrder,audit,canAccept=()=>true}) {
  let ticking=false,lastTick=Date.now();
  const jobById=id=>db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  function enqueue(kind,orderId,payload,id=randomUUID()){
    const now=Date.now();db.prepare('INSERT INTO jobs(id,kind,order_id,payload,state,next_at,created_at) VALUES(?,?,?,?,?,?,?)').run(id,kind,orderId,JSON.stringify(payload),'pending',now,now);return id;
  }
  function bound(p,o){return (!o.mode||o.mode===mode)&&p.id===o.paymentId&&p.metadata?.order_id===o.id&&p.amount?.currency==='RUB'&&p.amount?.value===o.total.toFixed(2)&&p.test===(mode==='yookassa_test');}
  function applyPayment(p,id){
    const o=readOrder(id);if(!o||!bound(p,o))throw new Error('Provider payment does not match order');
    o.receiptStatus=p.receipt_registration||o.receiptStatus||'not_requested';
    if(paymentMatches(p,o,mode)&&!o.paid){o.paid=true;o.status=!canAccept(o)||Date.now()>Date.parse(o.expiresAt||'2999-01-01')?'payment_review':'paid';o.pickupCode=o.status==='paid'?String(randomInt(100000,1000000)):null;o.paidAt=new Date().toISOString();audit('system','payment.confirmed',id,{status:o.status});}
    if(p.status==='canceled'&&!o.paid)o.status='canceled';
    if(p.refunded_amount?.currency==='RUB'){
      const amount=Number(p.refunded_amount.value);
      if(!Number.isFinite(amount)||amount<0||amount>o.total)throw new Error('Invalid refund amount');
      o.refundedAmount=amount;
      if(amount>0){o.pickupCode=null;o.status=amount===o.total?'refunded':'payment_review';}
    }
    o.paymentStatus=p.status;o.lastPaymentCheck=new Date().toISOString();saveOrder(o);return o;
  }
  async function refresh(o){if(!o.paymentId||mode==='demo')return o;try{return applyPayment(await yoo(`payments/${encodeURIComponent(o.paymentId)}`),o.id);}finally{const latest=readOrder(o.id);latest.lastPaymentAttempt=new Date().toISOString();saveOrder(latest);}}
  async function run(id){
    const changed=db.prepare("UPDATE jobs SET state='running',attempts=attempts+1 WHERE id=? AND state='pending' AND next_at<=?").run(id,Date.now());if(!changed.changes)return;
    const job=jobById(id);
    const order=readOrder(job.order_id);
    if(order?.mode&&order.mode!==mode){db.prepare("UPDATE jobs SET state='review',error='Payment mode changed; use the original environment for reconciliation' WHERE id=?").run(id);return;}
    if(Date.now()-job.created_at>23*3600000){db.prepare("UPDATE jobs SET state='review',error='Idempotency window expired: manual reconciliation required' WHERE id=?").run(id);audit('system','payment.manual_review',job.order_id);return;}
    try{
      const payload=JSON.parse(job.payload);
      const result=await yoo(job.kind==='payment'?'payments':'refunds',{method:'POST',headers:{'Idempotence-Key':job.id},body:JSON.stringify(payload)});
      let o=readOrder(job.order_id);
      if(job.kind==='payment'){
        if(typeof result.id!=='string')throw new Error('Missing provider payment id');
        o.paymentId=result.id;
        if(!bound(result,o))throw new Error('Payment response mismatch');
        const link=result.confirmation?.confirmation_url;
        if(link){const url=new URL(link);if(url.protocol!=='https:'||!/(^|\.)(yookassa\.ru|yoomoney\.ru)$/.test(url.hostname))throw new Error('Invalid payment URL');o.paymentUrl=url.href;}
        saveOrder(o);applyPayment(result,o.id);
      }else{
        if(result.payment_id!==o.paymentId||result.amount?.currency!=='RUB'||result.amount?.value!==payload.amount.value||typeof result.id!=='string')throw new Error('Refund response mismatch');
        o.refundId=result.id;o.refundStatus=result.status;o.refundReceiptStatus=result.receipt_registration||'pending';
        if(result.status==='succeeded'){o.refundedAmount=o.total;o.status='refunded';o.pickupCode=null;}
        saveOrder(o);
      }
      db.prepare("UPDATE jobs SET state='done',error=NULL WHERE id=?").run(id);
    }catch{
      db.prepare("UPDATE jobs SET state='pending',next_at=?,error='Provider operation failed; scheduled for reconciliation' WHERE id=?").run(Date.now()+Math.min(300000,5000*2**Math.min(job.attempts,6)),id);
    }
  }
  async function payment(o,payload){
    if(!o.paymentId){let job=db.prepare("SELECT id FROM jobs WHERE kind='payment' AND order_id=?").get(o.id);if(!job)job={id:enqueue('payment',o.id,payload,o.paymentKey)};await run(job.id);}
    return readOrder(o.id);
  }
  async function refund(o,payload,actor){
    if(o.refundKey||o.status==='refunded')return readOrder(o.id);
    if(!o.paid||o.refundedAmount>0)throw new Error('Заказ не оплачен или уже возвращён');
    if(mode==='demo'){o.status='refunded';o.refundStatus='succeeded';o.refundedAmount=o.total;o.pickupCode=null;saveOrder(o);audit(actor,'refund.demo',o.id);return o;}
    let id;db.exec('BEGIN IMMEDIATE');
    try{id=enqueue('refund',o.id,payload);o.refundKey=id;o.refundStatus='pending';o.status='payment_review';o.pickupCode=null;saveOrder(o);audit(actor,'refund.requested',o.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    await run(id);return readOrder(o.id);
  }
  async function tick(){
    if(ticking)return;ticking=true;lastTick=Date.now();
    try{
      for(const j of db.prepare("SELECT id FROM jobs WHERE state='pending' AND next_at<=? ORDER BY next_at LIMIT 5").all(Date.now()))await run(j.id);
      // Indexed ID lookup over all orders, including orders older than 500 rows.
      for(const event of db.prepare('SELECT * FROM webhook_inbox WHERE processed=0 AND next_at<=? ORDER BY next_at,received_at LIMIT 10').all(Date.now())){
        try{
          const p=await yoo(`payments/${encodeURIComponent(event.payment_id)}`);
          let o=readOrder(p.metadata?.order_id||'');
          if(o){if(!o.paymentId){const job=db.prepare("SELECT id FROM jobs WHERE kind='payment' AND order_id=?").get(o.id);if(!job)throw new Error('No durable payment attempt');o.paymentId=p.id;if(!bound(p,o))throw new Error('Payment mismatch');saveOrder(o);}applyPayment(p,o.id);}
          db.prepare('UPDATE webhook_inbox SET processed=1 WHERE id=?').run(event.id);
        }catch{db.prepare('UPDATE webhook_inbox SET next_at=? WHERE id=?').run(Date.now()+60000,event.id);}
      }
      const cutoff=new Date(Date.now()-30000).toISOString();
      const rows=db.prepare("SELECT body FROM orders WHERE json_extract(body,'$.paymentId') IS NOT NULL AND (json_extract(body,'$.lastPaymentAttempt') IS NULL OR json_extract(body,'$.lastPaymentAttempt')<?) AND json_extract(body,'$.status')!='refunded' ORDER BY COALESCE(json_extract(body,'$.lastPaymentAttempt'),'') LIMIT 10").all(cutoff);
      for(const row of rows){try{await refresh(JSON.parse(row.body));}catch{}}
      for(const row of db.prepare("SELECT body FROM orders WHERE json_extract(body,'$.refundStatus')='pending' AND json_extract(body,'$.refundId') IS NOT NULL LIMIT 10").all()){
        try{const o=JSON.parse(row.body),r=await yoo(`refunds/${encodeURIComponent(o.refundId)}`);const latest=readOrder(o.id);if(r.payment_id!==o.paymentId||r.amount?.value!==o.total.toFixed(2)||r.amount?.currency!=='RUB')continue;latest.refundStatus=r.status;latest.refundReceiptStatus=r.receipt_registration||latest.refundReceiptStatus;if(r.status==='succeeded'){latest.status='refunded';latest.refundedAmount=latest.total;latest.pickupCode=null;}saveOrder(latest);}catch{}}
    }finally{lastTick=Date.now();ticking=false;}
  }
  async function resolve(id,providerId,actor){
    const j=jobById(id);if(!j||j.state!=='review')throw new Error('Операция не требует ручной сверки');
    if(!/^[a-zA-Z0-9-]{1,100}$/.test(providerId))throw new Error('Некорректный ID провайдера');
    const o=readOrder(j.order_id);
    const result=await yoo((j.kind==='payment'?'payments/':'refunds/')+encodeURIComponent(providerId));
    if(j.kind==='payment'){
      const latest=readOrder(o.id);if(latest.paymentId&&latest.paymentId!==providerId)throw new Error('Заказ уже связан с другим платежом');
      latest.paymentId=providerId;if(!bound(result,latest))throw new Error('Платёж не соответствует заказу');saveOrder(latest);applyPayment(result,o.id);
    }else{
      const value=JSON.parse(j.payload).amount.value;
      if(result.payment_id!==o.paymentId||result.amount?.value!==value||result.amount?.currency!=='RUB')throw new Error('Возврат не соответствует операции');
      const latest=readOrder(o.id);latest.refundId=result.id;latest.refundStatus=result.status;
      if(result.status==='succeeded'){latest.refundedAmount=latest.total;latest.status='refunded';latest.pickupCode=null;}saveOrder(latest);
    }
    db.prepare("UPDATE jobs SET state='done',error=NULL WHERE id=? AND state='review'").run(id);audit(actor,'payment.manual_reconciled',o.id,{operation:id});
  }
  return {payment,refund,refresh,tick,run,enqueue,resolve,heartbeat:()=>lastTick};
}
