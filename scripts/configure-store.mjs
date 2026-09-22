import { readFileSync, existsSync } from 'node:fs';
if(existsSync('.env'))process.loadEnvFile('.env');
const file=process.argv[2];if(!file)throw new Error('Usage: node scripts/configure-store.mjs config/STORE.json');
const origin=process.env.APP_URL||'http://localhost:3000';
const login=await fetch(origin+'/api/admin/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password:process.env.ADMIN_PASSWORD||'kruti-local-2026'})});
if(!login.ok)throw new Error('Owner login failed');
const cookie=login.headers.get('set-cookie').split(';')[0];
try{const r=await fetch(origin+'/api/admin/settings',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({store:JSON.parse(readFileSync(file,'utf8'))})});if(!r.ok)throw new Error((await r.json()).error);console.log('Store configuration applied. Confirm real menu and hours before launch.');}
finally{await fetch(origin+'/api/admin/logout',{method:'POST',headers:{Origin:origin,Cookie:cookie}});}
