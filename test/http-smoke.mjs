import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(),'hunar-http-'));
const server = spawn(process.execPath, ['server/local.mjs'], {
  env: {...process.env, PORT:'0', HUNAR_DATA_DIR:dir},
  stdio:['ignore','pipe','inherit']
});
let base;
const start = new Promise((resolve,reject) => {
  const timeout = setTimeout(() => reject(new Error('Server did not bind within 5 seconds.')),5000);
  server.on('exit',code => { clearTimeout(timeout); reject(new Error('Local server exited ' + code)); });
  let out = '';
  server.stdout.on('data',chunk => {
    out += chunk.toString();
    const match = out.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) { clearTimeout(timeout); resolve(match[0]); }
  });
});

async function request(route, method = 'GET', role = '', data, type = 'application/json') {
  const response = await fetch(base + route,{
    method, headers:{...(role ? {'x-hunar-demo-role':role} : {}),...(data === undefined ? {} : {'Content-Type':type})},
    ...(data === undefined ? {} : {body:Buffer.isBuffer(data) ? data : JSON.stringify(data)})
  });
  return {status:response.status,type:response.headers.get('content-type'),data:response.headers.get('content-type')?.includes('json') ?
    await response.json() : Buffer.from(await response.arrayBuffer())};
}

try {
  base = await start;
  const html = await request('/');
  assert.equal(html.status,200);
  assert.match(html.data.toString(), /Hunar/);
  for (const asset of ['index.html','styles.css','app.mjs','learn.mjs','auth.mjs','choices.mjs','pack.json','sw.js','app.webmanifest','icon-192.png','icon-512.png','training-workshop.png']) {
    assert.equal((await request('/' + asset)).status,200,asset);
  }
  const flag = await request('/api/config');
  assert.equal(flag.data.demo,true);
  assert.equal((await request('/api/workspace')).status,401);
  const clip = await readFile('public/sample.mp4');
  const created = await request('/api/submissions','POST','worker',{type:'video/mp4',size:clip.length,consent:true});
  assert.equal(created.status,201);
  const p = '/api/submissions/' + created.data.id;
  assert.equal((await request(p + '/media','PUT','worker',Buffer.alloc(clip.length),'video/mp4')).status,400);
  assert.equal((await request(p + '/media','PUT','worker',clip,'video/mp4')).status,200);
  assert.equal((await request(p + '/submit','POST','worker')).data.status,'submitted');
  assert.equal((await request(p + '/media','GET','employer')).status,403);
  assert.deepEqual((await request(p + '/media','GET','reviewer')).data,clip);
  const approved = await request(p + '/review','POST','reviewer',{
    decision:'approved',findings:Object.fromEntries(['identify','assembly','visibility'].map(id => [id,{status:'met',note:'Fixture evidence'}]))
  });
  assert.equal(approved.data.status,'approved');
  const share = await request('/api/shares','POST','worker',{credentials:[created.data.id]});
  assert.equal((await request('/api/passport/' + share.data.token)).data.credentials.length,1);
  assert.equal((await request('/api/jobs/job-1/apply','POST','worker',{credentialId:created.data.id})).data.status,'submitted');
  assert.equal((await request('/api/workspace','GET','employer')).data.applications.length,1);
  assert.equal((await request('/api/jobs/job-1/close','POST','employer')).status,200);
  assert.equal((await request('/api/workspace','GET','worker')).data.applications.length,1);
  const event = {id:'http-1',deviceId:'test-device',profileId:'learner-a',questionId:'q1',answer:12,version:1};
  for (let i=0; i<2; i++) assert.equal((await request('/api/learning/sync','POST','teacher',{events:[event]})).data.ack[0],event.id);
  assert.equal((await request('/api/workspace','GET','teacher')).data.progress[0].answered,1);
  console.log('HTTP smoke passed: assets, role access, private evidence, review, passport, job application, school sync.');
} finally {
  if (server.exitCode === null) { const stopped = once(server,'exit'); server.kill(); await stopped; }
  await rm(dir,{recursive:true,force:true});
}
