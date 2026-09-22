const { chromium }=require('@playwright/test');
const fs=require('node:fs');
const os=require('node:os');const path=require('node:path');const {spawn}=require('node:child_process');
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kruti-browser-'));
  const origin='http://localhost:3002';
  const server=spawn(process.execPath,['server/index.mjs'],{windowsHide:true,env:{...process.env,PORT:'3002',APP_URL:origin,NODE_ENV:'development',PAYMENT_MODE:'demo',DATA_DIR:dir,ADMIN_PASSWORD:'kruti-local-2026'},stdio:['ignore','pipe','pipe']});
  let browser;
  try{
  await new Promise((resolve,reject)=>{server.stdout.on('data',c=>{if(String(c).includes('running at'))resolve();});server.once('error',reject);server.once('exit',c=>reject(new Error('Test server exited '+c)));});
  fs.mkdirSync('test-results',{recursive:true});
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)errors.push(r.status()+' '+r.url());});
  await page.goto(origin);await page.waitForSelector('.product');await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'test-results/desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Выбрать Та самая классика',exact:true}).click();await page.getByRole('checkbox',{name:'Сыр чеддер, плюс 50 рублей'}).check();await page.getByRole('button',{name:'В корзину · 340 ₽',exact:true}).click();
  await page.locator('#cart-button').click();await page.locator('#checkout').click();await page.locator('#demo-pay').click();await page.waitForSelector('.pickup-code');
  const code=(await page.locator('.pickup-code').textContent()).replace(/\s/g,'');console.log('Customer flow passed, pickup code generated:',code.length===6);
  await page.screenshot({path:'test-results/receipt.png'});await page.locator('#modal-close').click();
  const admin=await browser.newPage({viewport:{width:1440,height:1000}});await admin.goto(origin+'/admin');await admin.locator('#admin-password').fill('kruti-local-2026');await admin.getByRole('button',{name:'Войти →',exact:true}).click();await admin.waitForSelector('.admin-order');
  await admin.getByRole('button',{name:'Начать готовить',exact:true}).first().click();await admin.getByRole('button',{name:'Готово к выдаче',exact:true}).first().click();await admin.screenshot({path:'test-results/admin.png',fullPage:true});
  await admin.getByRole('button',{name:'Проверить код и выдать',exact:true}).first().click();await admin.locator('#pickup-code-input').fill(code);await admin.getByRole('button',{name:'Проверить и выдать заказ',exact:true}).click();await admin.waitForFunction(()=>!document.querySelector('#modal').open);console.log('Admin pickup flow passed');
  admin.on('pageerror',e=>errors.push(e.message));
  await admin.getByRole('button',{name:'Настройки точки',exact:true}).click();
  await admin.locator('[name="name"]').fill('Вкус востока');await admin.locator('[name="city"]').fill('Москва');await admin.locator('[name="address"]').fill('ул. Академика Волгина, 1');
  await admin.getByRole('button',{name:'Сохранить настройки',exact:true}).click();await admin.waitForFunction(()=>document.querySelector('#settings-result')?.textContent==='Настройки сохранены');
  await admin.screenshot({path:'test-results/settings.png',fullPage:true});
  await admin.getByRole('button',{name:'Сотрудники',exact:true}).click();await admin.locator('#staff-create [name="name"]').fill('Тестовый повар');await admin.locator('#staff-create [name="username"]').fill('testcook');await admin.locator('#staff-create [name="password"]').fill('browser-test-password');await admin.getByRole('button',{name:'Добавить сотрудника',exact:true}).click();await admin.getByText('Тестовый повар',{exact:true}).waitFor();
  await admin.getByRole('button',{name:'Состояние системы',exact:true}).click();await admin.getByRole('button',{name:'Журнал действий',exact:true}).waitFor();
  await admin.getByRole('button',{name:'История',exact:true}).click();await admin.getByRole('button',{name:'Вернуть оплату',exact:true}).first().click();await admin.locator('#refund-reason').fill('Проверка возврата в демо');await admin.getByRole('button',{name:'Подтвердить полный возврат',exact:true}).click();await admin.waitForFunction(()=>!document.querySelector('#modal').open);await admin.getByRole('button',{name:'История',exact:true}).click();await admin.getByText('Деньги возвращены',{exact:true}).waitFor();
  console.log('Store settings, staff creation, operations dashboard and refund UI passed');
  await page.setViewportSize({width:390,height:844});await page.goto(origin);await page.waitForSelector('.product');await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'test-results/mobile.png',fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);console.log('Mobile overflow:',overflow);console.log('Browser errors:',JSON.stringify(errors));if(errors.length||overflow)process.exitCode=1;
  await admin.getByRole('button',{name:'Меню',exact:true}).click();await admin.locator('#edit-menu').click();await admin.locator('.menu-editor-item summary').first().click();await admin.locator('[name="products:classic:name"]').fill('Классика обновлённая');await admin.locator('[name="products:classic:price"]').fill('399');await admin.locator('[data-add="products"]').click();await admin.getByRole('button',{name:'Сохранить меню',exact:true}).click();await admin.waitForFunction(()=>!document.querySelector('#modal').open);
  await page.goto(origin);await page.getByRole('button',{name:'Выбрать Классика обновлённая',exact:true}).waitFor();const products=await page.locator('.product').count();if(products!==7)throw new Error('Menu creation did not persist');await page.getByRole('button',{name:'Выбрать Классика обновлённая',exact:true}).click();await page.getByRole('button',{name:'В корзину · 399 ₽',exact:true}).waitFor();console.log('Menu edit, new product and server catalog reload passed');if(errors.length)throw new Error(errors.join('\n'));
  }finally{await browser?.close();if(server.exitCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill();});const resolved=path.resolve(dir);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('kruti-browser-'))fs.rmSync(resolved,{recursive:true,force:true});}
})();
