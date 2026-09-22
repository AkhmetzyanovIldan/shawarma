import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { backupDatabase } from '../server/operations.mjs';
import { existsSync } from 'node:fs';
if(existsSync('.env'))process.loadEnvFile('.env');
const data=path.resolve(process.env.DATA_DIR||'data');const db=new DatabaseSync(path.join(data,'kruti.sqlite'),{readOnly:true});
try{console.log(backupDatabase(db,path.join(data,'backups')));}finally{db.close();}
