import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { passwordHash } from '../server/platform.mjs';
if(existsSync('.env'))process.loadEnvFile('.env');
const password=process.env.NEW_OWNER_PASSWORD;
if(!password||password.length<16||password.length>128)throw new Error('Set NEW_OWNER_PASSWORD to a unique 16–128 character password in the process environment');
const db=new DatabaseSync(path.join(path.resolve(process.env.DATA_DIR||'data'),'kruti.sqlite'));
try{db.exec('BEGIN IMMEDIATE');const owner=db.prepare("SELECT id FROM staff WHERE username='owner'").get();if(!owner)throw new Error('Bootstrap owner not found');db.prepare("UPDATE staff SET password=?,active=1 WHERE id=?").run(passwordHash(password),owner.id);db.prepare("DELETE FROM sessions WHERE owner=? AND role='admin'").run(owner.id);db.prepare('INSERT INTO audit(at,actor,action,target,detail) VALUES(?,?,?,?,?)').run(new Date().toISOString(),'local-operator','owner.password_reset',owner.id,'{}');db.exec('COMMIT');console.log('Owner password changed; existing sessions revoked.');}catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
