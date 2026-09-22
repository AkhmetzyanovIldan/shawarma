import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
// Restore into a NEW directory. Existing data is never overwritten.
const [sourceArg,destinationArg]=process.argv.slice(2);
if(!sourceArg||!destinationArg)throw new Error('Usage: node scripts/restore.mjs BACKUP.sqlite NEW_DATA_DIR');
const source=path.resolve(sourceArg),destination=path.resolve(destinationArg);
if(existsSync(destination))throw new Error('Destination must not exist; restore never overwrites data');
const expected=readFileSync(source+'.sha256','utf8').trim();
if(createHash('sha256').update(readFileSync(source)).digest('hex')!==expected)throw new Error('Backup checksum mismatch');
const check=new DatabaseSync(source,{readOnly:true});
try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Corrupt backup');}finally{check.close();}
mkdirSync(destination,{recursive:true});copyFileSync(source,path.join(destination,'kruti.sqlite'));
const restored=new DatabaseSync(path.join(destination,'kruti.sqlite'));
restored.prepare('DELETE FROM sessions').run();restored.close();
console.log('Restored to '+destination+'. Sessions revoked. Reconcile provider payments before opening orders.');
