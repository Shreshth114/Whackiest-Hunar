import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeApi, accounts, searchTranscript } from '../server/api.mjs';
import { grade, pickQuestion, startProgress, validatePack } from '../public/learn.mjs';
import { choicePlacement } from '../public/choices.mjs';

function setup() {
  let state;
  const uploads = new Map();
  const db = {
    read: async initial => structuredClone(state || initial()),
    change: async (initial, fn) => {
      const copy = structuredClone(state || initial());
      const result = fn(copy);
      state = copy;
      return result;
    }
  };
  const media = {
    prepare: async item => ({mode:'put',url:'/api/submissions/' + item.id + '/media'}),
    put: async (item, bytes) => uploads.set(item.id,bytes),
    inspect: async item => uploads.has(item.id) ? {size:uploads.get(item.id).length,type:item.type,version:'test'} : null,
    play: async item => ({status:200,headers:{'Content-Type':item.type},body:uploads.get(item.id)})
  };
  const voice = { transcribe: async () => 'रामपुर में पाइप का काम', speak: async () => Buffer.from('mock audio') };
  const api = makeApi({ db, media, demo:true, voice });
  return async (role, method, route, data, mime) => {
    const actor = typeof role === 'object' ? role : accounts[role];
    const reply = await api({ path:'/api/' + route,method,actor,headers:{'content-type':mime || 'application/json'},
      body:Buffer.isBuffer(data) ? data : Buffer.from(data === undefined ? '' : JSON.stringify(data)) });
    return {status:reply.status, data:reply.headers['Content-Type'] === 'application/json' ? JSON.parse(reply.body) : reply.body};
  };
}
const get = (req, role, route) => req(role, 'GET', route);
const post = (req, role, route, data) => req(role, 'POST', route, data);
async function upload(req) {
  const clip = await readFile(new URL('../public/sample.mp4', import.meta.url));
  const creation = await post(req,'worker','submissions',{size:clip.length,type:'video/mp4',consent:true});
  assert.equal(creation.status,201);
  const id = creation.data.id;
  assert.equal((await get(req,'employer','submissions/' + id + '/media')).status,403);
  assert.equal((await post(req,'worker','submissions/' + id + '/submit')).status,409);
  assert.equal((await req('worker','PUT','submissions/' + id + '/media',clip,'video/mp4')).status,200);
  assert.equal((await post(req,'worker','submissions/' + id + '/submit')).data.status,'submitted');
  assert.deepEqual((await get(req,'reviewer','submissions/' + id + '/media')).data,clip);
  return id;
}

test('worker video, assigned review, credential, nearby application and revocable sharing', async () => {
  const req = setup();
  const id = await upload(req);
  const route = 'submissions/' + id + '/review';
  const approval = {decision:'approved',findings:Object.fromEntries(['identify','assembly','visibility'].map(k => [k,{status:'met',note:'visible in sample'}]))};
  assert.equal((await post(req,'worker',route,approval)).status,403);
  assert.equal((await post(req,{id:'other',role:'reviewer',name:'Other'},route,approval)).status,403);
  assert.equal((await post(req,'reviewer',route,approval)).data.status,'approved');
  assert.equal((await post(req,'reviewer',route,approval)).data.status,'approved');
  const passport = (await get(req,'worker','workspace')).data.credentials;
  assert.equal(passport.length,1);
  assert.equal(passport[0].kind,'Peer reviewed');
  const share = (await post(req,'worker','shares',{credentials:[id]})).data;
  const publicPassport = await get(req,undefined,'passport/' + share.token);
  assert.equal(publicPassport.status,200);
  assert.equal(publicPassport.data.name,'Hunar worker');
  assert.equal(JSON.stringify(publicPassport.data).includes('mediaVersion'),false);
  const jobs = (await get(req,'worker','jobs?trade=Plumbing&locality=Rampur')).data;
  assert.equal(jobs[0].id,'job-1');
  assert.ok(jobs[0].reasons.includes('Reviewed skill matches'));
  const applied = await post(req,'worker','jobs/job-1/apply',{credentialId:id});
  assert.equal(applied.status,201);
  assert.equal((await post(req,'worker','jobs/job-1/apply',{})).data.id,applied.data.id);
  assert.equal((await get(req,'employer','workspace')).data.applications.length,1);
  assert.equal((await post(req,'employer','applications/' + applied.data.id,{status:'shortlisted'})).data.status,'shortlisted');
  assert.equal((await post(req,'employer','jobs/job-2/close')).status,200);
  assert.equal((await post(req,'worker','jobs/job-2/apply',{})).status,409);
  assert.equal((await post(req,'reviewer','credentials/' + id + '/revoke',{reason:'Review correction'})).status,200);
  assert.equal((await get(req,undefined,'passport/' + share.token)).data.credentials[0].status,'revoked');
  assert.equal((await req('worker','DELETE','shares/' + share.shareId)).status,200);
  assert.equal((await get(req,undefined,'passport/' + share.token)).status,404);
});

test('offline adaptation and duplicate-safe sync stay within the teacher role', async () => {
  const req = setup();
  const pack = JSON.parse(await readFile(new URL('../public/pack.json', import.meta.url)));
  assert.equal(validatePack(pack),true);
  assert.equal(validatePack({...pack,questions:pack.questions.filter(q => q.level < 3)}),false);
  assert.equal(validatePack({...pack,questions:[...pack.questions,pack.questions[0]]}),false);
  const first = pickQuestion(pack,startProgress);
  const one = grade(startProgress,first,first.answer);
  const second = pickQuestion(pack,one);
  assert.notEqual(second.id,first.id);
  const two = grade(one,second,second.answer);
  assert.equal(two.level,2);
  const harder = pickQuestion(pack,two);
  assert.equal(harder.level,2);
  assert.equal(grade(two,harder,harder.choices.find(c => c !== harder.answer)).level,1);
  const row = {id:'answer-1',deviceId:'test-device',profileId:'learner-a',questionId:first.id,answer:first.answer,version:pack.version};
  assert.equal((await post(req,'worker','learning/sync',{events:[row]})).status,403);
  assert.equal((await post(req,'teacher','learning/sync',{events:[row,{...row,profileId:'another-class'}]})).status,400);
  assert.equal((await get(req,'teacher','workspace')).data.progress[0].answered,0);
  assert.deepEqual((await post(req,'teacher','learning/sync',{events:[row,row]})).data.ack,[row.id,row.id]);
  assert.equal((await post(req,'teacher','learning/sync',{events:[row]})).status,200);
  assert.equal((await get(req,'teacher','workspace')).data.progress[0].answered,1);
  assert.equal((await get(req,'teacher','jobs')).status,403);
});

test('voice draft leaves publishing and search confirmation with the user', async () => {
  const req = setup();
  const audio = Buffer.from('synthetic request');
  assert.equal((await req('teacher','POST','voice/search',audio,'audio/webm')).status,403);
  const result = await req('worker','POST','voice/search',audio,'audio/webm');
  assert.equal(result.status,200);
  assert.deepEqual(result.data.filters,{locality:'Rampur',trade:'Plumbing'});
  assert.deepEqual(searchTranscript('Plumbing jobs near Ramapur.'),{locality:'Rampur',trade:'Plumbing'});
  assert.equal(searchTranscript('Plumbing near Ram Pur').locality,'Rampur');
  assert.equal(searchTranscript('Plumbing near Shivpuri').locality,'');
  assert.equal(searchTranscript('Plumbing in Rampur or Shivpur').locality,'');
  const tts = await post(req,'worker','voice/read',{jobId:'job-1'});
  assert.equal(tts.status,200);
  assert.equal(tts.data.toString(),'mock audio');
});

test('interrupted and revised uploads retain a single attempt and worker ownership', async () => {
  const req = setup();
  const draft = {size:20,type:'video/mp4',consent:true,requestId:'upload-1'};
  const first = await post(req,'worker','submissions',draft);
  const id = first.data.id;
  assert.equal((await post(req,'worker','submissions',draft)).data.id,id);
  assert.equal((await post(req,'worker','submissions',{...draft,size:40})).status,409);
  assert.equal((await post(req,'reviewer','submissions/' + id + '/upload',draft)).status,403);
  assert.equal((await post(req,'worker','submissions/' + id + '/upload',{...draft,size:40})).status,400);
  assert.equal((await post(req,'worker','submissions/' + id + '/upload',draft)).data.upload.mode,'put');
  assert.equal((await req('worker','DELETE','submissions/' + id)).data.status,'discarded');
  assert.equal((await post(req,'worker','submissions/' + id + '/submit')).status,409);

  const old = await upload(req);
  const findings = Object.fromEntries(['identify','assembly','visibility'].map(key => [key,{status:'not_observable'}]));
  assert.equal((await post(req,'worker','submissions',{...draft,requestId:'upload-2',retryOf:old})).status,409);
  const review = await post(req,'reviewer','submissions/' + old + '/review',{decision:'changes_requested',findings});
  assert.equal(review.data.status,'changes_requested');
  const next = await post(req,'worker','submissions',{...draft,requestId:'upload-2',retryOf:old});
  assert.equal(next.status,201);
  assert.notEqual(next.data.id,old);
  const rows = (await get(req,'worker','workspace')).data.submissions;
  assert.equal(rows.find(row => row.id === next.data.id).retryOf,old);
  assert.equal(rows.find(row => row.id === old).review.decision,'changes_requested');
});

test('service worker can reopen the app offline and excludes private APIs and packs', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../public/sw.js', import.meta.url),'utf8');
  const listeners = {};
  const entries = new Map();
  const cache = {
    addAll: async paths => { for (const path of paths) entries.set(path, new Response('cached: ' + path)); },
    match: async path => entries.get(path),
    put: async (path, value) => entries.set(path, value)
  };
  runInNewContext(source, {
    URL, Response,
    self: { location:{origin:'https://hunar.test'}, addEventListener:(event,fn) => { listeners[event] = fn; }, skipWaiting:async () => {} },
    caches: { open:async () => cache },
    fetch: async () => { throw new Error('offline'); }
  });
  let install;
  listeners.install({waitUntil: job => { install = job; }});
  await install;
  assert.ok(entries.has('/auth.mjs'));
  assert.ok(entries.has('/choices.mjs'));
  let response;
  const request = (path, mode) => {
    response = undefined;
    listeners.fetch({
      request:{method:'GET',mode,url:'https://hunar.test' + path},
      respondWith: job => { response = job; }
    });
    return response;
  };
  assert.equal(await (await request('/','navigate')).text(),'cached: /');
  assert.equal(await (await request('/learn.mjs','cors')).text(),'cached: /learn.mjs');
  assert.equal(request('/api/workspace','cors'),undefined);
  assert.equal(request('/pack.json','cors'),undefined);
});

test('dropdowns stay inside narrow and short viewports', () => {
  const mobile = {width:320,height:580};
  const accountMenu = choicePlacement({left:192,top:12,bottom:62,width:119},mobile,175);
  assert.equal(accountMenu.up,false);
  assert.ok(accountMenu.left + accountMenu.width <= mobile.width - 10);
  const fieldMenu = choicePlacement({left:18,top:488,bottom:534,width:284},mobile,240);
  assert.equal(fieldMenu.up,true);
  assert.ok(fieldMenu.top >= 10);
  assert.equal(fieldMenu.top + fieldMenu.height,481);
  const short = choicePlacement({left:4,top:76,bottom:116,width:280},{width:285,height:175},245);
  assert.ok(short.height <= 59);
  assert.ok(short.left + short.width <= 275);
});
