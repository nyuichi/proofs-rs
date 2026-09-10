import {readFileSync,writeFileSync} from 'node:fs';
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
if(!account||!token) throw new Error('Cloudflare deployment credentials are required.');
async function api(path,options={}){
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,{...options,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});
 const data=await response.json();
 if(!response.ok||!data.success)throw new Error(`Cloudflare ${path}: ${JSON.stringify(data.errors)}`);
 return data.result;
}
const name='proofs-rs-dev-db';
let databases=await api('/d1/database?name='+name);
let db=databases.find(d=>d.name===name);
if(!db)db=await api('/d1/database',{method:'POST',body:JSON.stringify({name})});
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
if(db.uuid===config.d1_databases[0].database_id)throw new Error('Development must not use the production database.');
const subdomain=await api('/workers/subdomain');
const origin=`https://proofs-rs-dev.${subdomain.subdomain}.workers.dev`;
config.name='proofs-rs-dev';config.workers_dev=true;
config.vars={APP_ORIGIN:origin,APP_ENV:'development',DEMO_MODE:'true',GITHUB_CLIENT_ID:''};
config.d1_databases=[{binding:'DB',database_name:name,database_id:db.uuid,migrations_dir:'migrations'}];
writeFileSync('wrangler.dev.json',JSON.stringify(config,null,2));
writeFileSync('.dev-origin',origin);
console.log(`Development target: ${origin}; D1: ${name}`);
