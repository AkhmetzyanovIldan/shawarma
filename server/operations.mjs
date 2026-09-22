import { mkdirSync, openSync, writeFileSync, readFileSync, closeSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function acquireDataLock(data){
  const file=path.join(path.resolve(data),'server.lock'),token=randomUUID();
  if(existsSync(file)){
    const old=JSON.parse(readFileSync(file,'utf8'));let alive=true;
    try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
    if(alive)throw new Error('This DATA_DIR already has a running server. Use one instance per SQLite database.');
    unlinkSync(file);
  }
  const fd=openSync(file,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,token}));closeSync(fd);
  return ()=>{try{if(JSON.parse(readFileSync(file,'utf8')).token===token)unlinkSync(file);}catch{}};
}
export function backupDatabase(db,directory){
  const root=path.resolve(directory);mkdirSync(root,{recursive:true});
  const file=path.join(root,'kruti-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8)+'.sqlite');
  db.prepare('VACUUM INTO ?').run(file);
  const check=new DatabaseSync(file,{readOnly:true});
  try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Backup integrity check failed');}finally{check.close();}
  writeFileSync(file+'.sha256',createHash('sha256').update(readFileSync(file)).digest('hex')+'\n');
  // Delete only our own oldest snapshots inside this exact backup directory.
  const names=readdirSync(root).filter(n=>/^kruti-[\dT-]+Z-[a-f0-9]{8}\.sqlite$/.test(n)).sort();
  for(const name of names.slice(0,-48)){const target=path.resolve(root,name);if(path.dirname(target)!==root)throw new Error('Invalid backup path');unlinkSync(target);if(existsSync(target+'.sha256'))unlinkSync(target+'.sha256');}
  return file;
}
