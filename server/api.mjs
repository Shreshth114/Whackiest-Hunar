import { randomUUID, createHash } from 'node:crypto';
import { accounts, localities, neighbors, seed, students, task } from './data.mjs';
import { transcribe, speak } from './voice.mjs';
import { readFileSync } from 'node:fs';

const pack = JSON.parse(readFileSync(new URL('../public/pack.json', import.meta.url), 'utf8'));
const trades = ['Plumbing', 'General'];
const videoTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
const maxVideoBytes = 20 * 1024 * 1024;
const clean = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const json = (value, status = 200) => ({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(value) });
const binary = (body, type) => ({ status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }, body });
const isOpen = job => job.status === 'open' && job.expiry > now();
const validId = value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/i.test(value);
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;

export function searchTranscript(transcript) {
  const lower = transcript.toLowerCase();
  const words = ' ' + lower.normalize('NFC').replace(/[^\p{L}\p{M}]+/gu, ' ').trim() + ' ';
  const aliases = {
    Rampur: ['rampur', 'ramapur', 'ram pur', 'रामपुर'],
    Shivpur: ['shivpur', 'shivapur', 'shiv pur', 'शिवपुर'],
    Basantpur: ['basantpur', 'basant pur', 'vasantpur', 'बसंतपुर', 'बसन्तपुर', 'वसंतपुर']
  };
  const locations = localities.filter(area => aliases[area].some(alias => words.includes(' ' + alias + ' ')));
  return {
    locality: locations.length === 1 ? locations[0] : '',
    trade: /plumb|pipe|प्लंब|प्लम्|पाइप|नल/.test(lower) ? 'Plumbing' : /general|सामान्य/.test(lower) ? 'General' : ''
  };
}

function filterJobs(state, worker, q) {
  const profile = own(state.profiles, worker);
  const locality = localities.includes(q.get('locality')) ? q.get('locality') : profile?.locality || localities[0];
  const areas = [locality, ...neighbors[locality]];
  const trade = trades.includes(q.get('trade')) ? q.get('trade') : '';
  const skills = new Set(Object.values(state.credentials).filter(c => c.workerId === worker && c.status === 'active').map(c => c.skill));
  return Object.values(state.jobs)
    .filter(job => isOpen(job) && areas.includes(job.locality) && (!trade || job.trade === trade))
    .map(job => {
      const same = job.locality === locality;
      const matched = skills.has(job.skill);
      return {
        ...job, rank: (same ? 2 : 1) + (matched ? 2 : 0) + (profile?.available ? 1 : 0),
        reasons: [same ? 'Same locality' : 'Neighboring locality', ...(matched ? ['Reviewed skill matches'] : []),
          profile?.available ? 'Open to work' : 'Confirm your availability']
      };
    })
    .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title));
}

export function makeApi({ db, media, demo = false, config = {}, voice = { transcribe, speak }, extract = null, initial = seed }) {
  const read = () => db.read(initial);
  const change = fn => db.change(initial, fn);
  const check = (actor, role) => {
    if (!actor) fail(401, 'Sign in to continue.');
    if (role && actor.role !== role) fail(403, 'This action requires the ' + role + ' role.');
    return actor.id;
  };
  const studyProfile = (teacher, id) => students.some(item => item.id === id) ? teacher + ':' + id : '';
  function submission(state, id) {
    const item = own(state.submissions, id);
    if (!item) fail(404, 'Submission not found.');
    return item;
  }
  function maySee(item, actor) {
    const id = check(actor);
    if (!(actor.role === 'worker' && item.workerId === id) &&
        !(actor.role === 'reviewer' && item.reviewerId === id)) fail(403, 'This evidence is private.');
  }
  function useVoiceQuota(uid) {
    return change(state => {
      const day = now().slice(0,10);
      if (state.voiceQuota?.day !== day) state.voiceQuota = { day, total: 0, users: {} };
      const quota = state.voiceQuota;
      const key = hash(uid);
      const used = own(quota.users, key) || 0;
      if (used >= 20 || quota.total >= 120) fail(429, 'Voice usage limit reached today. You can use the text controls.');
      quota.users[key] = used + 1;
      quota.total++;
    });
  }
  return async function api(req) {
    const url = new URL(req.path, 'http://hunar.local');
    const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const [group, id, action] = path;
    const method = req.method;
    const actor = req.actor;
    const body = () => {
      try {
        const value = JSON.parse(req.body?.toString() || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        return value;
      } catch { fail(400, 'Send a valid form.'); }
    };
    try {
      if (method === 'GET' && group === 'config') return json({ demo, ...config, voice: Boolean(process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_SECRET_ARN), readAloud: Boolean(process.env.ELEVENLABS_VOICE_ID) });
      if (method === 'GET' && group === 'passport' && /^[a-f0-9-]{36}$/.test(id || '')) {
        const state = await read();
        const share = own(state.shares, hash(id));
        if (!share?.active) fail(404, 'This passport link is unavailable.');
        const credentials = share.credentials.map(key => own(state.credentials, key)).filter(Boolean)
          .map(({ workerId, id, ...publicFields }) => publicFields);
        return json({ name: share.name, credentials });
      }

      const uid = check(actor);
      if (method === 'GET' && group === 'workspace') {
        const state = await read();
        const role = actor.role;
        const items = Object.values(state.submissions).filter(item => role === 'worker' ? item.workerId === uid : role === 'reviewer' && item.reviewerId === uid);
        const publicItems = items.map(({ key, mediaVersion, requestId, ...item }) => item);
        const credentials = role === 'worker' ? Object.values(state.credentials).filter(item => item.workerId === uid) : [];
        const jobs = role === 'employer' ? Object.values(state.jobs).filter(item => item.employerId === uid) : [];
        const applications = Object.values(state.applications).filter(item => role === 'worker' ? item.workerId === uid : role === 'employer' && own(state.jobs,item.jobId)?.employerId === uid);
        const progress = role === 'teacher' ? students.map(item => {
          const attempts = Object.values(state.events).filter(event => event.profileId === studyProfile(uid, item.id));
          return { ...item, answered: attempts.length, correct: attempts.filter(event => event.correct).length };
        }) : [];
        for (const application of applications) {
          if (application.credentialId && own(state.credentials, application.credentialId)?.status === 'revoked') {
            application.credentialSummary = { ...application.credentialSummary, kind:'Credential revoked' };
          }
        }
        return json({ actor, profile: own(state.profiles, uid), task, localities, trades, submissions: publicItems,
          credentials, shares: Object.entries(state.shares).filter(([, item]) => item.workerId === uid && item.active).map(([key]) => key),
          jobs, applications, progress, students: role === 'teacher' ? students : [] });
      }

      if (method === 'POST' && group === 'profile') {
        check(actor, 'worker');
        const data = body();
        if (!clean(data.name, 60) || !localities.includes(data.locality) || !trades.includes(data.trade)) fail(400, 'Complete your name, locality and trade.');
        const profile = { name: clean(data.name, 60), locality: data.locality, trade: data.trade, language: data.language === 'hi' ? 'hi' : 'en', available: !!data.available };
        return json(await change(state => (state.profiles[uid] = profile)));
      }

      if (method === 'POST' && group === 'submissions' && !id) {
        check(actor, 'worker');
        const data = body();
        if (!videoTypes.includes(data.type) || !Number.isInteger(data.size) || data.size < 1 || data.size > maxVideoBytes) fail(400, 'Choose an MP4, WebM or MOV video up to 20 MB.');
        if (data.consent !== true) fail(400, 'Confirm that the assigned reviewer may watch this video.');
        if (data.requestId && !validId(data.requestId)) fail(400, 'Invalid upload request.');
        const submissionId = randomUUID();
        const item = await change(state => {
          const attempts = Object.values(state.submissions).filter(row => row.workerId === uid);
          const previous = data.requestId && attempts.find(row => row.requestId === data.requestId);
          if (previous) {
            if (previous.type !== data.type || previous.size !== data.size ||
                (previous.retryOf || null) !== (data.retryOf || null)) fail(409, 'Choose the original video for this upload attempt.');
            return previous;
          }
          const source = data.retryOf ? own(state.submissions, data.retryOf) : null;
          if (data.retryOf && (source?.workerId !== uid || source.status !== 'changes_requested')) fail(409, 'This review cannot be retried.');
          if (attempts.filter(row => row.status === 'draft').length >= 20) fail(429, 'Too many unfinished uploads. Continue or discard one from Your attempts.');
          const row = {
            id: submissionId, workerId: uid, workerName: own(state.profiles, uid)?.name || actor.name,
            reviewerId: source?.reviewerId || config.reviewer || 'reviewer',
            taskId: task.id, taskVersion: task.version, status: 'draft', key: 'evidence/' + submissionId,
            type: data.type, size: data.size, createdAt: now(),
            ...(data.requestId ? { requestId: data.requestId } : {}),
            ...(source ? { retryOf: source.id } : {})
          };
          state.submissions[row.id] = row;
          return row;
        });
        return json({ id: item.id, status: item.status, upload: item.status === 'draft' ? await media.prepare(item) : null }, 201);
      }

      if (group === 'submissions' && id) {
        const item = submission(await read(), id);
        maySee(item, actor);
        if (method === 'POST' && action === 'upload') {
          if (item.workerId !== uid) fail(403, 'Only the worker may upload evidence.');
          const data = body();
          if (data.consent !== true || data.size !== item.size || data.type !== item.type) fail(400, 'Choose the original video and confirm reviewer access.');
          return json({ id, status: item.status, upload: item.status === 'draft' ? await media.prepare(item) : null });
        }
        if (method === 'DELETE' && !action) {
          if (item.workerId !== uid) fail(403, 'Only the worker may discard a draft.');
          return json(await change(state => {
            const current = submission(state, id);
            if (current.status !== 'draft') fail(409, 'Only an unfinished upload can be discarded.');
            current.status = 'discarded';
            return { id, status: current.status };
          }));
        }
        if (method === 'PUT' && action === 'media' && demo) {
          if (item.workerId !== uid || item.status !== 'draft') fail(403, 'This upload is closed.');
          if (req.body.length !== item.size || req.headers['content-type'] !== item.type) fail(400, 'Video size or format changed.');
          await media.put(item, req.body);
          return json({ ok: true });
        }
        if (method === 'GET' && action === 'media') {
          if (['draft','discarded'].includes(item.status)) fail(409, 'There is no submitted video for this attempt.');
          return media.play(item, req.headers.range);
        }
        if (method === 'POST' && action === 'submit') {
          if (item.workerId !== uid) fail(403, 'Only the worker may submit this evidence.');
          if (item.status === 'discarded') fail(409, 'This upload was discarded.');
          if (item.status !== 'draft') return json({ id, status: item.status });
          const stored = await media.inspect(item);
          if (!stored || stored.size !== item.size || stored.type !== item.type) fail(409, 'Upload did not finish. Retry with the same file.');
          return json(await change(state => {
            const current = submission(state, id);
            if (current.status === 'discarded') fail(409, 'This upload was discarded.');
            if (current.status === 'draft') {
              current.status = 'submitted';
              current.mediaVersion = stored.version;
            }
            return { id, status: current.status };
          }));
        }
        if (method === 'POST' && action === 'review') {
          check(actor, 'reviewer');
          const data = body();
          const statuses = ['met', 'needs_work', 'not_observable'];
          const findings = task.criteria.map(criterion => ({
            id: criterion.id, label: criterion.label,
            status: data.findings?.[criterion.id]?.status, note: clean(data.findings?.[criterion.id]?.note, 100)
          }));
          if (!findings.every(f => statuses.includes(f.status)) || !['approved','changes_requested'].includes(data.decision)) fail(400, 'Record a finding for each criterion.');
          if (data.decision === 'approved' && !findings.every(f => f.status === 'met' && f.note)) fail(400, 'Approval needs every criterion met and an evidence note for each.');
          return json(await change(state => {
            const current = submission(state, id);
            if (own(state.reviews, id)) return { status: current.status, review: state.reviews[id] };
            if (current.status !== 'submitted') fail(409, 'Only submitted evidence can be reviewed.');
            const review = { decision: data.decision, findings, note: clean(data.note, 400), reviewer: actor.name, date: now() };
            state.reviews[id] = review;
            current.status = data.decision;
            current.review = review;
            if (data.decision === 'approved') state.credentials[id] = {
              id, workerId: current.workerId, task: task.title, taskVersion: task.version, skill: task.skill,
              issuer: actor.name, kind: actor.role === 'reviewer' ? 'Peer reviewed' : 'Reviewed',
              date: review.date, evidence: findings.map(f => ({ label: f.label, note: f.note })), status: 'active', demo: Boolean(config.demoListings ?? demo)
            };
            return { status: current.status, review };
          }));
        }
      }

      if (group === 'shares') {
        check(actor, 'worker');
        if (method === 'POST') {
          const data = body();
          const candidates = Array.isArray(data.credentials) ? [...new Set(data.credentials)].slice(0, 5) : [];
          const token = randomUUID();
          const shareId = hash(token);
          await change(state => {
            if (!candidates.length || !candidates.every(key => validId(key) && own(state.credentials, key)?.workerId === uid && state.credentials[key].status === 'active')) fail(400, 'Choose an active credential to share.');
            state.shares[shareId] = { workerId: uid, active: true, name: data.showName ? own(state.profiles, uid)?.name || actor.name : 'Hunar worker', credentials: candidates };
          });
          return json({ token, shareId }, 201);
        }
        if (method === 'DELETE') return json(await change(state => {
          const row = own(state.shares, id);
          if (row?.workerId !== uid) fail(404, 'Share not found.');
          row.active = false;
          return { ok: true };
        }));
      }

      if (group === 'credentials' && method === 'POST' && action === 'revoke') {
        check(actor, 'reviewer');
        const reason = clean(body().reason, 300);
        if (!reason) fail(400, 'Give a reason for revocation.');
        return json(await change(state => {
          const credential = own(state.credentials, id);
          if (!credential || state.submissions[id]?.reviewerId !== uid) fail(404, 'Credential not found.');
          if (credential.status === 'active') Object.assign(credential, { status: 'revoked', revokedAt: now(), reason });
          return { status: credential.status };
        }));
      }

      if (group === 'jobs' && !id && method === 'GET') {
        check(actor, 'worker');
        return json(filterJobs(await read(), uid, url.searchParams));
      }

      if (group === 'jobs' && !id && method === 'POST') {
        check(actor, 'employer');
        const data = body();
        if (!clean(data.title, 80) || !localities.includes(data.locality) || !trades.includes(data.trade) ||
            !Number.isInteger(data.wage) || data.wage < 1 || data.wage > 1000000 || !['hour','day','job'].includes(data.wageUnit) ||
            typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ||
            !Number.isFinite(Date.parse(data.date)) || data.date < now().slice(0,10) ||
            !Number.isInteger(data.openings) || data.openings < 1 || data.openings > 100) fail(400, 'Check the role, location, schedule, wage and openings.');
        const jobId = randomUUID();
        const row = { id: jobId, title: clean(data.title, 80), employerId: uid, employerName: actor.name, locality: data.locality,
          trade: data.trade, wage: data.wage, wageUnit: data.wageUnit, date: data.date, openings: data.openings,
          skill: data.trade === 'Plumbing' ? task.skill : '', status: 'open', demo: Boolean(config.demoListings ?? demo),
          expiry: new Date(Date.parse(data.date) + 86400000).toISOString() };
        await change(state => { state.jobs[jobId] = row; });
        return json(row, 201);
      }

      if (group === 'jobs' && id && method === 'POST' && action === 'close') {
        check(actor, 'employer');
        return json(await change(state => {
          const job = own(state.jobs, id);
          if (job?.employerId !== uid) fail(404, 'Job not found.');
          job.status = 'closed';
          return { status: 'closed' };
        }));
      }

      if (group === 'jobs' && id && method === 'POST' && action === 'apply') {
        check(actor, 'worker');
        const data = body();
        return json(await change(state => {
          const job = own(state.jobs, id);
          const applicationId = hash(uid + ':' + id).slice(0, 32);
          if (own(state.applications, applicationId)) return state.applications[applicationId];
          if (!job || !isOpen(job)) fail(409, 'That listing is closed.');
          const credential = data.credentialId ? own(state.credentials, data.credentialId) : null;
          if (data.credentialId && (credential?.workerId !== uid || credential.status !== 'active')) fail(400, 'Choose an active credential.');
          const row = { id: applicationId, jobId: id, title: job.title, workerId: uid, workerName: own(state.profiles, uid)?.name || actor.name,
            credentialId: credential?.id || null, credentialSummary: credential ? { skill: credential.skill, kind: credential.kind } : null,
            status: 'submitted', date: now() };
          state.applications[applicationId] = row;
          return row;
        }), 201);
      }

      if (group === 'applications' && id && method === 'POST') {
        const data = body();
        return json(await change(state => {
          const row = own(state.applications, id);
          if (!row) fail(404, 'Application not found.');
          const employer = actor.role === 'employer' && own(state.jobs, row.jobId)?.employerId === uid;
          const worker = actor.role === 'worker' && row.workerId === uid;
          if (!employer && !worker) fail(403, 'This application is private.');
          if (row.status === data.status) return row;
          if (!(employer && row.status === 'submitted' && ['shortlisted','declined'].includes(data.status)) &&
            !(worker && ['submitted','shortlisted'].includes(row.status) && data.status === 'withdrawn')) fail(409, 'This status change is unavailable.');
          row.status = data.status;
          return row;
        }));
      }

      if (group === 'learning' && method === 'POST' && id === 'sync') {
        check(actor, 'teacher');
        const batch = body().events;
        if (!Array.isArray(batch) || batch.length > 50) fail(400, 'Upload up to 50 practice answers at a time.');
        return json(await change(state => {
          const ack = batch.map(event => {
            const profileId = studyProfile(uid, event?.profileId);
            const q = pack.questions.find(q => q.id === event?.questionId);
            if (!profileId || !validId(event?.id) || !validId(event?.deviceId) || !q || event.version !== pack.version || !q.choices.includes(event.answer)) fail(400, 'Invalid practice answer.');
            const key = hash(profileId + ':' + event.id);
            if (!own(state.events, key)) state.events[key] = { profileId, id: event.id, correct: event.answer === q.answer,
              questionId: q.id, answer: event.answer, version: event.version, deviceId: event.deviceId,
              clientCreatedAt: clean(event.clientCreatedAt, 40), receivedAt: now() };
            return event.id;
          });
          return { ack };
        }));
      }

      if (group === 'voice' && id === 'search' && method === 'POST') {
        check(actor, 'worker');
        const mime = req.headers['content-type'] || '';
        if (!/^audio\/(webm|mp4|ogg|wav|mpeg)(;.*)?$/.test(mime) || !req.body.length || req.body.length > 1500000) fail(400, 'Record a short audio request.');
        await useVoiceQuota(uid);
        const transcript = await voice.transcribe(req.body, mime);
        if (!transcript) fail(422, 'No clear speech was detected. Try again or type.');
        const known = searchTranscript(transcript);
        let suggested = null;
        if (extract && (!known.locality || !known.trade)) {
          try { suggested = await extract(transcript); } catch { /* Keep the deterministic filters. */ }
        }
        return json({ transcript, filters: { locality:known.locality || suggested?.locality || '', trade:known.trade || suggested?.trade || '' } });
      }
      if (group === 'voice' && id === 'read' && method === 'POST') {
        check(actor, 'worker');
        const job = own((await read()).jobs, body().jobId);
        if (!job || !isOpen(job)) fail(404, 'Job not found.');
        const text = job.title + ' in ' + job.locality + '. ' + job.wage + ' rupees per ' + job.wageUnit + '.';
        await useVoiceQuota(uid);
        return binary(await voice.speak(text), 'audio/mpeg');
      }
      fail(404, 'This page or action does not exist.');
    } catch (error) {
      if (!error.status) console.error('API failure', error.name);
      return json({ error: error.status ? error.message : 'Something went wrong. Please retry.' }, error.status || 500);
    }
  };
}

export { accounts };
