import { mkdirSync, lstatSync, chownSync, accessSync, constants } from 'node:fs';
import path from 'node:path';

// The official node image supplies node:node with UID/GID 1000.
// Only the two dedicated data mount paths may be prepared as root.
const data=path.resolve(process.env.DATA_DIR||'/var/data');
if(!['/var/data','/app/data'].includes(data))throw new Error('Docker DATA_DIR must be /var/data (Render) or /app/data (Compose)');
mkdirSync(data,{recursive:true,mode:0o700});
if(lstatSync(data).isSymbolicLink())throw new Error('DATA_DIR must be a directory, not a symlink');
if(process.getuid?.()===0){
  // Change only the mount directory, never recursively rewrite stored files.
  chownSync(data,1000,1000);
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
accessSync(data,constants.R_OK|constants.W_OK|constants.X_OK);
await import('./index.mjs');
