// Development preview only. End users open the published site in their browser.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createState, snapshot, applyAction } from './profile.mjs';
import { createHash } from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const plan=JSON.parse((await fs.readFile(path.join(root,'data/plan.json'),'utf8')).replace(/^\uFEFF/,''));
const profiles=new Map();
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost:47831');
 const json=(body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
 try {
  if(u.pathname==='/api/config')return json({pushReady:false,publicKey:null});
  if(u.pathname.startsWith('/api/')) {
   const token=req.headers.authorization?.replace(/^Bearer /,'');if(!/^[a-f0-9]{64}$/.test(token||''))return json({error:'Нужен индивидуальный профиль.'},401);
   const id=createHash('sha256').update(token).digest('hex');
   if(!profiles.has(id))profiles.set(id,{state:createState(plan),version:1});
   const p=profiles.get(id);
   if(u.pathname==='/api/state'&&req.method==='GET')return json(snapshot(plan,p));
   if(u.pathname!=='/api/action'||req.method!=='POST')return json({error:'Неизвестный адрес.'},404);
   if(!['http://localhost:47832','http://127.0.0.1:47832'].includes(req.headers.origin))return json({error:'Origin rejected'},403);
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>12000)throw new Error('Запрос слишком большой.');}
   const input=JSON.parse(raw);
   if(input.version!==p.version)return json({...snapshot(plan,p),error:'План изменился в другой вкладке. Повтори действие.'},409);
   if(input.type==='subscribe'||input.type==='test'||input.type==='notifications'&&input.enabled)return json({error:'Push-уведомления будут доступны после публикации.'},503);
   p.state=applyAction(plan,p.state,input);p.version++;
   return json(snapshot(plan,p));
  }
  const file=path.resolve(root,'public','.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
  if(!file.startsWith(path.join(root,'public')+path.sep))return json({error:'Forbidden'},403);
  const content=await fs.readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(content);
 }catch(error){json({error:error.code==='ENOENT'?'Not found':error.message},error.code==='ENOENT'?404:400);}
});
server.listen(47832,'127.0.0.1',()=>console.log('Preview: http://localhost:47832'));
