import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('Customer/admin flow, auth boundaries, one-time pickup and persistent orders',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'kruti-test-'));const port=31000+Math.floor(Math.random()*10000);const origin=`http://localhost:${port}`;let processRef;
  const start=async()=>{processRef=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,PORT:String(port),APP_URL:origin,NODE_ENV:'development',PAYMENT_MODE:'demo',DATA_DIR:dir,ADMIN_PASSWORD:'test-admin-password'},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{processRef.stdout.on('data',chunk=>{if(String(chunk).includes('running at'))resolve();});processRef.once('error',reject);processRef.once('exit',code=>reject(new Error('Server exited '+code)));});};
  const stop=()=>new Promise(resolve=>{processRef.once('exit',resolve);processRef.kill();});
  const request=async(route,method='GET',data,cookie='',customOrigin=origin)=>{const r=await fetch(origin+route,{method,headers:{Origin:customOrigin,'Content-Type':'application/json',Cookie:cookie},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  try{
    await start();
    assert.equal((await request('/api/admin/orders')).status,401);
    const a=await request('/api/session','POST',{}), b=await request('/api/session','POST',{});const cookie=a.cookie;
    const orderInput={items:[{id:'classic',quantity:2,size:'large',extras:['cheddar','carrot'],price:1}],requestKey:'test-request-key-0000001',pickup:'asap'};
    const created=await request('/api/orders','POST',orderInput,cookie);assert.equal(created.status,201);assert.equal(created.body.total,930);const id=created.body.id;
    assert.equal((await request('/api/orders','POST',orderInput,cookie)).body.id,id);
    assert.equal((await request(`/api/orders/${id}`,'GET',undefined,b.cookie)).status,404);
    assert.equal((await request(`/api/orders/${id}/demo-pay`,'POST',{},cookie,'https://attacker.example')).status,403);
    const paid=await request(`/api/orders/${id}/demo-pay`,'POST',{},cookie);assert.equal(paid.body.paid,true);assert.match(paid.body.pickupCode,/^\d{6}$/);
    const login=await request('/api/admin/login','POST',{password:'test-admin-password'});const adminCookie=login.cookie;
    const listed=await request('/api/admin/orders','GET',undefined,adminCookie);assert.equal(listed.body[0].pickupCode,undefined);
    assert.equal((await request(`/api/admin/orders/${id}`,'POST',{action:'collect',code:paid.body.pickupCode},adminCookie)).status,409);
    assert.equal((await request(`/api/admin/orders/${id}`,'POST',{action:'prepare'},adminCookie)).body.status,'preparing');
    assert.equal((await request(`/api/admin/orders/${id}`,'POST',{action:'ready'},adminCookie)).body.status,'ready');
    assert.equal((await request(`/api/admin/orders/${id}`,'POST',{action:'collect',code:'000000'},adminCookie)).status,400);
    assert.equal((await request(`/api/admin/orders/${id}`,'POST',{action:'collect',code:paid.body.pickupCode},adminCookie)).body.status,'collected');
    assert.equal((await request(`/api/admin/orders/${id}`,'POST',{action:'collect',code:paid.body.pickupCode},adminCookie)).status,409);
    assert.equal((await request(`/api/orders/${id}`,'GET',undefined,cookie)).body.pickupCode,undefined);
    await request('/api/admin/settings','POST',{acceptingOrders:false},adminCookie);
    assert.equal((await request('/api/orders','POST',{...orderInput,requestKey:'test-request-key-0000002'},cookie)).status,409);
    await stop();await start();
    assert.equal((await request(`/api/orders/${id}`,'GET',undefined,cookie)).body.status,'collected');
    await request('/api/admin/logout','POST',{},adminCookie);assert.equal((await request('/api/admin/orders','GET',undefined,adminCookie)).status,401);
  }finally{if(processRef?.exitCode===null)await stop();await rm(dir,{recursive:true,force:true});}
});
