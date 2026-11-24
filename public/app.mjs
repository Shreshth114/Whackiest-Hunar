import { readLocal, writeLocal, removeLocal, recordAnswer, eventsFor, clearLearner, validatePack, startProgress, pickQuestion, grade } from './learn.mjs';
import { idToken, signIn, finishSignIn, signOut } from './auth.mjs';
import { closeChoices, enhanceChoices } from './choices.mjs';

const main = document.querySelector('main');
const nav = document.querySelector('#nav');
const account = document.querySelector('#account');
const notice = document.querySelector('#notice');
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const tag = (label, kind = '') => '<span class="tag ' + kind + '">' + esc(label) + '</span>';
const button = (label, action, cls = '') => '<button type="button" data-action="' + esc(action) + '" class="' + cls + '">' + esc(label) + '</button>';
const link = (label, page, cls = '') => '<a class="button ' + cls + '" href="#' + esc(page) + '">' + esc(label) + '</a>';
const showStatus = state => ({ changes_requested:'Changes requested', submitted:'Submitted', approved:'Approved', draft:'Upload pending', discarded:'Discarded', active:'Active', revoked:'Revoked', shortlisted:'Shortlisted', declined:'Declined', withdrawn:'Withdrawn', open:'Open', closed:'Closed' })[state] || state;
const statusTag = state => tag(showStatus(state), ({
  approved:'active', shortlisted:'active', draft:'waiting', changes_requested:'waiting', submitted:'waiting',
  revoked:'revoked', declined:'revoked', closed:'neutral', withdrawn:'neutral', discarded:'neutral'
})[state] || '');
const languages = ['en','hi'];
const demoRoles = { worker:'Worker', reviewer:'Reviewer', employer:'Employer', teacher:'Teacher & school' };
const defaultLocalities = ['Rampur','Shivpur','Basantpur'];
const defaultTrades = ['Plumbing','General'];
let role = sessionStorage.getItem('hunar.role') || 'worker';
let config = {};
let workspace = null;
let workspaceError = '';
let page = 'home';
let headerKey = '';
let filters = { locality:'', trade:'' };
let results = [];
let voiceDraft = '';
let filterNote = '';
let locale = localStorage.getItem('hunar.study.lang') || 'en';
let learner = 'learner-a';
let pack = null;
let offlineShellReady = Boolean(navigator.serviceWorker?.controller);
let studySyncNote = '';
let progress = startProgress;
let feedback = null;
let savingAnswer = false;
let question = null;
let blobUrls = [];
let recording = null;
let lastShare = null;
let uploadTarget = null;
let uploadRequest = null;
let uploadInFlight = false;
let notifyTimer;
let syncInFlight = false;
let pending = 0;
let rendering = 0;
let offlineOwner = localStorage.getItem('hunar.study.owner') || '';
let deviceId = localStorage.getItem('hunar.device');
if (!deviceId) { deviceId = crypto.randomUUID(); localStorage.setItem('hunar.device', deviceId); }

function alertUser(message) {
  clearTimeout(notifyTimer);
  notice.textContent = '';
  const item = document.createElement('div');
  item.className = 'notice';
  item.textContent = message;
  notice.append(item);
  notifyTimer = setTimeout(() => notice.replaceChildren(), 6100);
}
const currentRole = () => workspace?.actor.role || (config.demo ? role : '');
const title = (label, heading, detail = '') => '<div class="page-title"><p class="eyebrow">' + esc(label) + '</p><h1>' + esc(heading) + '</h1>' + (detail ? '<p>' + esc(detail) + '</p>' : '') + '</div>';
const empty = (heading, detail) => '<div class="card empty-state"><span class="empty-mark" aria-hidden="true"></span><div><h2>' + esc(heading) + '</h2><p class="muted">' + esc(detail) + '</p></div></div>';
const options = (values, selected, all = '') => (all ? '<option value="">' + esc(all) + '</option>' : '') + values.map(v =>
  '<option' + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>').join('');

function requestHeaders(extra) {
  return { ...(config.demo ? {'x-hunar-demo-role':role} : {}), ...(idToken() ? {Authorization:'Bearer ' + idToken()} : {}), ...extra };
}
async function http(path, init = {}) {
  const response = await fetch('/api/' + path, { ...init, headers: requestHeaders(init.headers) });
  if (!response.ok) {
    let message = 'Request failed (' + response.status + ').';
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response;
}
const api = (path, method = 'GET', data) => http(path, { method, ...(data !== undefined ? {
  headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)
} : {}) }).then(r => r.json());

async function refresh() {
  workspaceError = '';
  try {
    workspace = await api('workspace');
    if (workspace.actor.role === 'teacher') {
      offlineOwner = workspace.actor.id;
      localStorage.setItem('hunar.study.owner', offlineOwner);
    }
  } catch (error) {
    workspace = null;
    if (config.demo || idToken()) workspaceError = navigator.onLine ? error.message : 'You are offline.';
  }
}
function releaseMedia() {
  for (const url of blobUrls) URL.revokeObjectURL(url);
  blobUrls = [];
}

function header() {
  const mode = currentRole();
  const key = JSON.stringify([mode,page,config.demo,config.authUrl,Boolean(idToken()),Boolean(offlineOwner)]);
  if (key === headerKey) return;
  headerKey = key;
  const menu = [['home','Home'], ...(mode === 'worker' ? [['learn','Learn'],['proof','Prove'],['jobs','Nearby'],['passport','Passport'],['profile','Profile']] :
    mode === 'reviewer' ? [['review','Review queue']] : mode === 'employer' ? [['employer','Employer desk']] :
    mode === 'teacher' || offlineOwner ? [['school','School'],...(mode === 'teacher' ? [['teacher','Class progress']] : [])] : [['school','School']])];
  nav.innerHTML = menu.map(([route, name]) => '<a href="#' + route + '"' + (route === page ? ' aria-current="page"' : '') + '>' + name + '</a>').join('');
  account.innerHTML = config.demo ? '<select id="role-select" aria-label="Demo role" data-choice-heading="Demo workspace">' +
    Object.entries(demoRoles).map(([value,label]) => '<option value="' + value + '"' + (role === value ? ' selected' : '') + '>' + esc(label) + '</option>').join('') + '</select>' :
    config.authUrl ? button(idToken() ? 'Sign out' : 'Sign in', idToken() ? 'sign-out' : 'sign-in', 'secondary') : '';
  enhanceChoices(account);
}

function home() {
  const mode = currentRole();
  const primary = { worker:['Start a skill assessment','proof'], reviewer:['Open review queue','review'],
    employer:['Open employer desk','employer'], teacher:['Open school practice','school'] }[mode];
  const features = [
    ['learn','Learn at your pace',mode === 'worker' ? 'Prepare for a practical assessment with a short lesson.' : 'Download practice in English or Hindi and keep learning offline.', mode === 'worker' ? 'learn' : 'school','Explore learning'],
    ['proof','Prove a skill','Submit a practical video and share a skill a reviewer has assessed.', mode === 'reviewer' ? 'review' : mode === 'worker' ? 'proof' : '', 'View assessment'],
    ['nearby','Find nearby work','Compare local openings, see what they pay, and decide which skills to share.', mode === 'employer' ? 'employer' : mode === 'worker' ? 'jobs' : '', 'View jobs']
  ];
  return '<section class="hero"><div class="hero-content"><p class="eyebrow">Learning and local work</p><h1>Build skills.<br><span>Find work nearby.</span></h1><p>Practise at your pace, show what you can do, and connect with employers close to home.</p>' +
    '<div class="actions">' + (primary ? link(primary[0], primary[1], 'light') : config.authUrl ? button('Sign in','sign-in','light') : link('Open school practice','school','light')) +
    (mode === 'worker' ? link('Find nearby jobs','jobs','secondary') : '') + '</div></div>' +
    '<div class="hero-media" aria-hidden="true"></div></section>' +
    '<div class="section-heading home-section-heading"><h2>Explore your workspace</h2></div><div class="grid feature-grid">' +
    features.map(([icon, label, detail, route, call]) => '<article class="card feature"><span class="feature-id feature-' + icon + '" aria-hidden="true"><i></i></span><h3>' +
      label + '</h3><p class="muted">' + detail + '</p>' + (route ? link(call,route,'secondary') : '') + '</article>').join('') + '</div>';
}

function learning() {
  return title('Vocational practice','Prepare for a pipe connection assessment','Learn what the reviewer needs to see before you film.') +
    '<div class="grid two"><article class="card"><h2>Show the fitting and the joint</h2><ol><li>Use a disconnected practice rig with a trainer.</li>' +
    '<li>Name the pipe and fitting so the reviewer can follow your work.</li><li>Keep the alignment and completed joint visible in the frame.</li></ol>' +
    link('Open assessment','proof') + '</article><article class="card tint" lang="hi"><h2>अपना काम साफ़ दिखाएँ</h2><p>प्रशिक्षक के साथ बिना पानी की आपूर्ति वाले अभ्यास उपकरण का उपयोग करें। पाइप और फिटिंग का नाम बताएँ और तैयार जोड़ साफ़ दिखाएँ।</p></article></div>';
}

function profile() {
  const p = workspace?.profile || {};
  const name = p.name || workspace?.actor.name || 'Worker';
  const initials = name.trim().split(/\s+/).slice(0,2).map(part => [...part][0]).join('').toLocaleUpperCase();
  return title('Worker account','Your profile','Choose what employers see and set your preferences for nearby work.') +
   '<div class="profile-layout"><form class="card profile-form" id="profile-form"><div class="card-intro"><h2>Profile details</h2><p class="muted">Use the name you want to appear on your applications.</p></div>' +
   '<label>Display name<input required name="name" maxlength="60" value="' + esc(name) + '"></label><div class="form-row">' +
   '<label>Locality<select name="locality">' + options(defaultLocalities,p.locality) + '</select></label><label>Trade<select name="trade">' + options(defaultTrades,p.trade) +
   '</select></label></div><label>Preferred language<select name="language"><option value="en">English</option><option value="hi"' + (p.language === 'hi' ? ' selected' : '') + '>हिन्दी</option></select></label>' +
   '<label class="inline setting"><input name="available" type="checkbox"' + (p.available ? ' checked' : '') + '><span>Open to work<small>Include your availability in nearby job matches.</small></span></label>' +
   '<div class="form-footer"><button>Save profile</button></div></form><aside class="card profile-summary" aria-label="Saved profile">' +
   '<p class="eyebrow">Saved profile</p><span class="profile-avatar" aria-hidden="true">' + esc(initials) + '</span><h2>' + esc(name) + '</h2>' +
   (p.trade || p.locality ? '<p class="muted">' + esc([p.trade,p.locality].filter(Boolean).join(' · ')) + '</p>' : '') +
   (p.available ? tag('Open to work','active') : '') + '<hr class="rule"><p class="fine">Your skill passport only shows the credentials you choose to share.</p>' +
   link('View passport','passport','secondary') + '</aside></div>';
}

function reviewSummary(review) {
  if (!review) return '';
  return '<p>' + esc(review.note || 'Reviewer findings') + '</p><ul>' + review.findings.map(f => '<li>' + esc(f.label) + ' · ' +
    esc(({met:'Met',needs_work:'Needs work',not_observable:'Not observable'})[f.status]) + (f.note ? ' · ' + esc(f.note) : '') + '</li>').join('') + '</ul>';
}

function proof() {
  const list = workspace.submissions.filter(item => item.status !== 'discarded');
  const target = uploadTarget && list.find(item => item.id === uploadTarget.id);
  return title('Skill assessment','Show your practical skills','A reviewer checks what your video shows against a task rubric.') +
    '<div class="grid two"><article class="card tint"><p class="eyebrow">Plumbing assistant</p><h2>' + esc(workspace.task.title) + '</h2><p>' + esc(workspace.task.brief) +
    '</p><ul>' + workspace.task.criteria.map(c => '<li>' + esc(c.label) + '</li>').join('') + '</ul></article>' +
    '<form class="card" id="upload-form"><h2>' + (target?.status === 'draft' ? 'Continue unfinished upload' : target ? 'Submit another attempt' : 'Submit a demonstration') +
    '</h2>' + (target ? '<p class="info">' + (target.status === 'draft' ? 'Select the original video again.' : 'Film a new clip that addresses your previous feedback.') + '</p>' : '') +
    '<label>Video, up to 20 MB<input required type="file" name="video" accept="video/mp4,video/webm,video/quicktime" capture="environment"></label>' +
    '<label class="inline"><input type="checkbox" name="consent" required> Allow the assigned reviewer to watch this video.</label><p class="fine">Aim for 30–60 seconds. You can keep using Hunar if an upload fails and retry when you have a connection.</p>' +
    '<div class="actions"><button>Upload for review</button>' + (config.demo ? button('Use sample clip','fixture','secondary') : '') +
    (target ? button('Cancel selection','upload-cancel','secondary') : '') + '</div><p id="upload-progress" class="fine" aria-live="polite"></p></form></div>' +
    '<div class="section-heading"><h2>Your attempts</h2></div><div class="stack">' + (list.length ? list.slice().reverse().map(item =>
      '<article class="card"><div class="cardhead"><h3>' + esc(workspace.task.title) + '</h3>' + statusTag(item.status) +
      '</div><p class="fine">' + esc(new Date(item.createdAt).toLocaleString()) + (item.retryOf ? ' · Follow-up attempt' : '') + '</p>' + reviewSummary(item.review) +
      (item.status === 'approved' ? link('Open passport','passport','secondary') : item.status === 'changes_requested' ?
        '<div class="actions">' + link('Review the lesson','learn','secondary') + button('Submit another attempt','upload-revise:' + item.id,'secondary') + '</div>' :
        item.status === 'draft' ? '<div class="actions">' + button('Continue upload','upload-continue:' + item.id) +
        button('Discard draft','upload-discard:' + item.id,'secondary') + '</div>' : '') + '</article>').join('') :
      empty('No attempts yet','Submit a clip to see its review status here.')) + '</div>';
}

function reviewQueue() {
  const list = workspace.submissions.filter(item => !['draft','discarded'].includes(item.status));
  return title('Reviewer desk','Review queue','Review the observable task and record what the video shows.') + '<div class="stack">' +
    (list.length ? list.slice().reverse().map(item => '<article class="card"><div class="cardhead"><h2>' + esc(item.workerName) + '</h2>' +
      statusTag(item.status) + '</div><p>' + esc(workspace.task.title) + '</p><div id="media-' + esc(item.id) + '"></div>' +
      button('Open evidence','video:' + item.id,'secondary') +
      (item.status === 'submitted' ? '<hr class="rule"><form data-review="' + esc(item.id) + '">' +
        workspace.task.criteria.map(c => '<fieldset><legend>' + esc(c.label) + '</legend><div class="form-row"><label>Finding<select name="' + c.id +
          '" required><option value="">Choose finding</option><option value="met">Met</option><option value="needs_work">Needs work</option><option value="not_observable">Not observable</option></select></label>' +
          '<label>Timestamp or evidence note<input name="' + c.id + '-note" maxlength="100" placeholder="At 00:12, the joint is visible"></label></div></fieldset>').join('') +
          '<label>Feedback<textarea name="note" maxlength="400"></textarea></label><div class="actions"><button name="decision" value="approved">Approve task</button>' +
          '<button class="secondary" name="decision" value="changes_requested">Request another attempt</button></div></form>' : reviewSummary(item.review)) +
      (item.status === 'approved' ? '<hr class="rule"><form class="inline-form" data-revoke="' + esc(item.id) + '"><label>Revocation reason<input name="reason" maxlength="300" required></label><button class="secondary">Revoke credential</button></form>' : '') +
      '</article>').join('') : empty('No assigned submissions','A worker submission will appear here when its video upload is complete.')) + '</div>';
}

function credentialMarkup(c) {
  return '<article class="card credential"><div class="cardhead"><h2>' + esc(c.skill) + '</h2>' + statusTag(c.status) +
    '</div><div class="tags">' + tag(c.kind) + (c.demo ? tag('Demo credential','demo') : '') + '</div><p>' + esc(c.task) + '</p><p class="fine">Reviewed by ' +
    esc(c.issuer) + ' · ' + esc(new Date(c.date).toLocaleDateString()) + ' · Rubric v' + esc(c.taskVersion) + '</p>' +
    (c.status === 'revoked' ? '<p>' + esc(c.reason) + '</p>' : '<ul>' + c.evidence.map(f => '<li>' + esc(f.label) + ' · ' + esc(f.note) + '</li>').join('') + '</ul>') + '</article>';
}

function passport() {
  const credentials = workspace.credentials;
  const active = credentials.filter(c => c.status === 'active');
  const shared = lastShare ? location.origin + '/#share/' + lastShare.token : '';
  return title('Skill passport','Your reviewed skills','A passport records specific tasks and who reviewed them.') + '<div class="stack">' +
    (credentials.length ? credentials.map(credentialMarkup).join('') : empty('No credentials yet','A successful practical review will appear on your passport.')) +
    (active.length ? '<form class="card narrow" id="share-form"><h2>Share a credential</h2><label>Credential<select name="credential">' +
      active.map(c => '<option value="' + esc(c.id) + '">' + esc(c.skill) + ' · ' + esc(new Date(c.date).toLocaleDateString()) + '</option>').join('') +
      '</select></label><label class="inline"><input type="checkbox" name="showName"> Include my display name</label><div><button>Create share link</button></div>' +
      (shared ? '<label>Share link<input readonly value="' + esc(shared) + '"></label><div class="actions"><a href="' + esc(shared) + '" target="_blank" rel="noopener">Open public passport</a>' + button('Copy link','copy-share','secondary') + '</div>' : '') +
      '</form>' : '') + (workspace.shares.length ? '<section class="card narrow"><h2>Active share links</h2>' +
      workspace.shares.map((id, i) => '<p>Link ' + (i+1) + ' ' + button('Disable','disable:' + id,'secondary') + '</p>').join('') + '</section>' : '') + '</div>';
}

function jobs() {
  const credentials = workspace.credentials.filter(c => c.status === 'active');
  const applications = workspace.applications;
  return title('Local opportunities','Work close to home','Search by locality and trade. Review pay and choose which evidence to share.') +
    '<section class="card"><form class="inline-form" id="search-form"><label>Locality<select name="locality">' + options(defaultLocalities,filters.locality || workspace.profile?.locality) +
    '</select></label><label>Trade<select name="trade">' + options(defaultTrades,filters.trade,'All trades') +
    '</select></label><button>Search</button>' + (config.voice ? button(recording ? 'Stop recording' : 'Search by voice','voice',recording ? 'secondary recording' : 'secondary') : '') + '</form>' +
    (config.voice ? '<p class="fine">Try “plumbing near Rampur”. Audio goes to ElevenLabs for transcription. Review the result before using it.</p>' :
      '<p class="fine">Voice search is unavailable on this installation.</p>') +
    (voiceDraft ? '<div class="info">Heard: ' + esc(voiceDraft) + '<br>Check the filters, then select Search.</div>' : '') + '</section>' +
    '<div class="section-heading"><h2>Available listings</h2>' + tag(filterNote || results.length + ' results') + '</div>' +
    '<div class="grid two">' + (results.length ? results.map(job => {
      const application = applications.find(a => a.jobId === job.id);
      return '<article class="card listing"><div class="cardhead"><h3>' + esc(job.title) + '</h3>' + (job.demo ? tag('Demo listing','demo') : '') +
        '</div><p class="muted">' + esc(job.employerName) + ' · ' + esc(job.locality) + '</p><p class="wage">₹' + esc(job.wage) + ' / ' + esc(job.wageUnit) +
        '</p><p>Starts ' + esc(job.date) + ' · ' + job.openings + (job.openings === 1 ? ' opening' : ' openings') + '</p><p class="reasons">' + esc(job.reasons.join(' · ')) + '</p>' +
        (config.readAloud && config.voice ? '<div class="actions">' + button('Read listing aloud','speak:' + job.id,'secondary') + '</div>' : '') +
        (application ? '<p>' + statusTag(application.status) + '</p>' :
        '<form data-apply="' + esc(job.id) + '"><label>Share evidence<select name="credential"><option value="">Apply without a credential</option>' +
        credentials.map(c => '<option value="' + esc(c.id) + '">' + esc(c.skill) + '</option>').join('') +
        '</select></label><div><button>Apply</button></div></form>') + '</article>';
    }).join('') : empty('No jobs match','Change the trade or select a nearby locality.')) + '</div>' +
    (applications.length ? '<div class="section-heading"><h2>My applications</h2></div><div class="stack">' +
    applications.slice().reverse().map(item => '<article class="card"><div class="cardhead"><h3>' + esc(item.title) + '</h3>' +
      statusTag(item.status) + '</div><p class="fine">Applied ' + esc(new Date(item.date).toLocaleDateString()) +
      (item.credentialSummary ? ' · Shared ' + esc(item.credentialSummary.skill) : '') + '</p>' +
      (['submitted','shortlisted'].includes(item.status) ? button('Withdraw application','withdraw:' + item.id,'secondary') : '') +
      '</article>').join('') + '</div>' : '');
}

function employer() {
  return title('Employer desk','Post jobs and review applications','Publish local openings with clear wages and schedules.') +
    '<form class="card narrow" id="job-form"><h2>Post an opening</h2><label>Job title<input name="title" required maxlength="80"></label>' +
    '<div class="form-row"><label>Locality<select name="locality">' + options(defaultLocalities) + '</select></label><label>Trade<select name="trade">' + options(defaultTrades) +
    '</select></label><label>Wage in rupees<input type="number" name="wage" min="1" max="1000000" required></label><label>Pay per<select name="wageUnit">' +
    options(['hour','day','job'],'day') + '</select></label><label>Start date<input type="date" name="date" required value="' + new Date(Date.now()+86400000).toISOString().slice(0,10) +
    '"></label><label>Openings<input type="number" name="openings" value="1" required min="1" max="100"></label></div><div><button>Publish job</button></div></form>' +
    '<div class="section-heading"><h2>Your listings</h2></div><div class="stack">' + (workspace.jobs.length ? workspace.jobs.slice().reverse().map(job => {
      const list = workspace.applications.filter(a => a.jobId === job.id);
      return '<article class="card"><div class="cardhead"><h3>' + esc(job.title) + '</h3><div class="tags">' + statusTag(job.status) + (job.demo ? tag('Demo listing','demo') : '') +
        '</div></div><p>' + esc(job.locality) + ' · ₹' + esc(job.wage) + ' / ' + esc(job.wageUnit) + '</p>' +
        (job.status === 'open' ? button('Close listing','close:' + job.id,'secondary') : '') +
        '<hr class="rule"><h3>Applications</h3>' +
        (list.length ? list.map(a => '<div class="info"><strong>' + esc(a.workerName) + '</strong> ' + statusTag(a.status) + '<p>' +
          esc(a.credentialSummary ? a.credentialSummary.kind + ' · ' + a.credentialSummary.skill : 'No credential shared') + '</p>' +
          (a.status === 'submitted' ? '<div class="actions">' + button('Shortlist','shortlisted:' + a.id) + button('Decline','declined:' + a.id,'secondary') + '</div>' : '') +
          '</div>').join('') : '<p class="muted">No applications yet.</p>') + '</article>';
    }).join('') : empty('No listings yet','Publish your first opening.')) + '</div>';
}

function school() {
  const hi = locale === 'hi';
  const canSync = navigator.onLine && currentRole() === 'teacher' && !!workspace;
  const difficulty = ['', hi ? 'बुनियादी' : 'Foundations',hi ? 'अभ्यास' : 'Practice',hi ? 'चुनौती' : 'Challenge'];
  return title('School mode',hi ? 'रोज़मर्रा का गणित' : 'Everyday numeracy',hi ? 'सीखने के लिए इंटरनेट की ज़रूरत नहीं है। पैक पहले डाउनलोड करें।' :
      'Download the pack once, then practise without internet.') +
    '<section class="card narrow"><div class="cardhead"><h2>' + (hi ? 'अभ्यास पैक' : 'Practice pack') + '</h2><div class="tags">' +
    tag(navigator.onLine ? 'Online' : 'Offline',navigator.onLine ? '' : 'off') +
    (pack ? tag(offlineShellReady ? 'Ready offline' : 'Pack saved · Preparing offline access') : '') + '</div></div>' +
    '<div class="form-row"><label>Language<select id="study-lang"><option value="en">English</option><option value="hi"' + (hi ? ' selected' : '') + '>हिन्दी</option></select></label>' +
    '<label>Learner<select id="learner-select"><option value="learner-a">Learner A</option><option value="learner-b"' + (learner === 'learner-b' ? ' selected' : '') +
    '>Learner B</option></select></label></div><p class="fine">' + pending + ' pending sync · Progress is stored under a learner alias on this device.</p>' +
    (studySyncNote ? '<p class="info">' + esc(studySyncNote) + '</p>' : '') +
    '<div class="actions">' + (!pack && navigator.onLine ? button('Download practice pack','download') : '') +
    (canSync ? button('Sync now','sync','secondary') : '') + (currentRole() === 'teacher' && navigator.onLine ? link('Class progress','teacher','secondary') : '') +
    (progress.answered ? button('Clear this learner on this device','clear-learner','secondary') : '') + '</div></section>' +
    (pack && question ? '<article class="card narrow" style="margin-top:1rem" lang="' + locale + '"><div class="cardhead"><h2>' + (hi ? 'सवाल' : 'Practice question') +
    '</h2>' + tag(difficulty[progress.level]) + '</div><p class="question">' + esc(question[locale]) + '</p>' +
    (feedback ? '<div class="info">' + (feedback.correct ? (hi ? 'सही!' : 'Correct!') : (hi ? 'फिर कोशिश करें।' : 'Keep practising.')) + ' ' + esc(question[hi ? 'whyHi' : 'why']) +
      '</div>' + button(hi ? 'अगला सवाल' : 'Next question','next-question') :
      '<div class="choices">' + question.choices.map(choice => button(String(choice),'answer:' + choice,'secondary')).join('') + '</div>') +
    '<p class="fine">' + progress.answered + (hi ? ' उत्तर दिए' : ' answered') + '</p></article>' : '');
}

function teacher() {
  return title('Teacher desk','Class progress','Counts include practice answers synced from this device or other devices.') +
    '<div class="grid two">' + workspace.progress.map(row => '<article class="card"><h2>' + esc(row.label) + '</h2><p class="metric">' +
    row.correct + ' / ' + row.answered + '</p><p class="muted">Correct answers / attempts</p></article>').join('') +
    '</div><div class="actions" style="margin-top:1rem">' + link('Open practice','school') + '</div>';
}

const renderers = { home, learn:learning, profile, proof, review:reviewQueue, passport, jobs, employer, school, teacher };
const required = { learn:'worker', proof:'worker', profile:'worker', passport:'worker', jobs:'worker', review:'reviewer', employer:'employer', teacher:'teacher' };
const schoolOwner = () => currentRole() === 'teacher' && workspace ? workspace.actor.id : offlineOwner || 'guest';
const studyKey = () => schoolOwner() + ':' + learner;
async function loadPractice() {
  const stored = await readLocal('pack');
  pack = validatePack(stored) ? stored : null;
  progress = await readLocal('progress:' + studyKey()) || startProgress;
  feedback = null;
  question = pack ? pickQuestion(pack,progress) : null;
  pending = (await eventsFor(schoolOwner())).length;
}
async function loadJobs() {
  results = await api('jobs?' + new URLSearchParams({
    locality: filters.locality || workspace.profile?.locality || defaultLocalities[0], trade:filters.trade
  }));
  filterNote = '';
}
function paint(markup, animate) {
  const choice = document.activeElement?.closest('.choice');
  const select = choice && main.contains(choice) ? choice.querySelector('select') : null;
  const key = select?.id || select?.name;
  main.innerHTML = '<div class="view-frame' + (animate ? ' view-enter' : '') + '">' + markup + '</div>';
  enhanceChoices(main);
  if (key && !animate) {
    const replacement = [...main.querySelectorAll('.choice select')].find(node => (node.id || node.name) === key);
    replacement?.closest('.choice')?.querySelector('.choice-trigger')?.focus({preventScroll:true});
  }
}
async function render({ fetchJobs = false } = {}) {
  const gen = ++rendering;
  const path = location.hash.slice(1);
  if (path === 'main') return;
  closeChoices();
  page = path.split('/')[0] || 'home';
  const animate = main.dataset.view !== page;
  main.dataset.view = page;
  header();
  releaseMedia();
  try {
    if (page === 'share') {
      const passport = await api('passport/' + encodeURIComponent(path.split('/')[1] || ''));
      if (gen === rendering) paint(title('Shared skill passport',passport.name) + '<div class="stack">' + passport.credentials.map(credentialMarkup).join('') + '</div>', animate);
      return;
    }
    if (page === 'school' && !pack) await loadPractice();
    if (required[page] && (required[page] !== currentRole() || !workspace)) {
      if (gen === rendering) paint(empty('This view requires ' + required[page] + ' access', workspaceError || 'Sign in or select the matching demo account.'), animate);
      return;
    }
    if (page === 'jobs' && fetchJobs) await loadJobs();
    if (gen === rendering) paint((Object.hasOwn(renderers,page) ? renderers[page] : home)(), animate);
  } catch (error) {
    if (gen === rendering) paint(empty('Unable to open this view', error.message), animate);
  }
}

async function sendEvidence(file, consent) {
  if (uploadInFlight) return;
  if (!file?.size || file.size > 20 * 1024 * 1024) throw new Error('Choose a video up to 20 MB.');
  const type = file.type || (/\.mov$/i.test(file.name) ? 'video/quicktime' : /\.webm$/i.test(file.name) ? 'video/webm' : 'video/mp4');
  const context = uploadTarget;
  const signature = [file.name,file.size,type,file.lastModified,context?.id].join('|');
  if (uploadRequest?.signature !== signature) uploadRequest = { signature, id:crypto.randomUUID() };
  const progressText = document.querySelector('#upload-progress');
  uploadInFlight = true;
  try {
    progressText.textContent = 'Preparing your upload…';
    const data = { size:file.size, type, consent };
    const destination = context?.mode === 'continue' ? 'submissions/' + context.id + '/upload' : 'submissions';
    const { id, upload, status } = await api(destination,'POST',{
      ...data, requestId:uploadRequest.id, ...(context?.mode === 'revise' ? {retryOf:context.id} : {})
    });
    if (status === 'discarded') throw new Error('This upload was discarded. Select a new attempt.');
    if (upload) {
      progressText.textContent = 'Uploading video…';
      if (upload.mode === 'post') {
        const form = new FormData();
        for (const [key,value] of Object.entries(upload.fields)) form.set(key,value);
        form.set('file',file);
        const response = await fetch(upload.url,{method:'POST',body:form});
        if (!response.ok) throw new Error('The private video upload failed.');
      } else {
        await http('submissions/' + id + '/media',{method:'PUT',headers:{'Content-Type':type},body:file});
      }
      progressText.textContent = 'Sending the attempt to your reviewer…';
      await api('submissions/' + id + '/submit','POST');
    }
    uploadTarget = null;
    uploadRequest = null;
    await refresh();
    await render();
    alertUser('Video submitted for review.');
  } catch (error) {
    progressText.textContent = error.message + ' You can retry without starting a new attempt.';
    throw error;
  } finally {
    uploadInFlight = false;
  }
}

async function syncPractice(silent = false) {
  if (syncInFlight || !navigator.onLine || currentRole() !== 'teacher' || !workspace) return;
  syncInFlight = true;
  try {
    const owner = workspace.actor.id;
    const rows = await eventsFor(owner);
    for (let i = 0; i < rows.length; i += 50) {
      const result = await api('learning/sync','POST',{events:rows.slice(i,i+50).map(({ owner, ...event }) => event)});
      for (const id of result.ack) await removeLocal('event:' + id);
    }
    pending = (await eventsFor(owner)).length;
    if (rows.length) studySyncNote = 'Synced ' + rows.length + (rows.length === 1 ? ' answer.' : ' answers.');
    await refresh();
    if (!silent) alertUser(rows.length ? 'Practice answers synced.' : 'Practice is up to date.');
  } catch (error) {
    studySyncNote = 'Sync paused. Unsent answers are still saved on this device.';
    if (!silent) alertUser(error.message + ' ' + studySyncNote);
  } finally { syncInFlight = false; }
}

async function beginVoice() {
  if (recording) { recording.stop(); return; }
  if (!navigator.mediaDevices || !globalThis.MediaRecorder) throw new Error('This device cannot record audio here.');
  const stream = await navigator.mediaDevices.getUserMedia({audio:true});
  let recorder;
  try { recorder = new MediaRecorder(stream); }
  catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  const chunks = [];
  let limit;
  recording = recorder;
  recorder.addEventListener('dataavailable', e => { if (e.data.size) chunks.push(e.data); });
  recorder.addEventListener('stop', async () => {
    clearTimeout(limit);
    stream.getTracks().forEach(track => track.stop());
    recording = null;
    if (page !== 'jobs' || currentRole() !== 'worker') return;
    alertUser('Transcribing your search…');
    try {
      const type = recorder.mimeType || chunks[0]?.type || 'audio/webm';
      const clip = new Blob(chunks,{type});
      const response = await http('voice/search',{method:'POST',headers:{'Content-Type':type},body:clip});
      const result = await response.json();
      if (page !== 'jobs' || currentRole() !== 'worker') return;
      voiceDraft = result.transcript;
      filters = { locality:result.filters.locality || filters.locality, trade:result.filters.trade || filters.trade };
      results = [];
      filterNote = 'Review search filters';
      await render();
    } catch (error) { alertUser(error.message); if (page === 'jobs') await render(); }
  }, {once:true});
  recorder.start();
  limit = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 12000);
  await render();
}

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const data = new FormData(form);
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    if (form.id === 'search-form') {
      filters = {locality:data.get('locality'),trade:data.get('trade')};
      voiceDraft = '';
      await render({fetchJobs:true});
      return;
    }
    if (form.id === 'upload-form') { await sendEvidence(data.get('video'),data.has('consent')); return; }
    if (form.id === 'profile-form') {
      await api('profile','POST',{...Object.fromEntries(data),available:data.has('available')});
      filters = {locality:'',trade:''};
      alertUser('Profile saved.');
    } else if (form.dataset.review) {
      const findings = Object.fromEntries(workspace.task.criteria.map(c => [c.id,{status:data.get(c.id),note:data.get(c.id+'-note')}]));
      await api('submissions/' + form.dataset.review + '/review','POST',{ findings, decision:submit?.value, note:data.get('note') });
      alertUser('Review saved.');
    } else if (form.dataset.revoke) {
      await api('credentials/' + form.dataset.revoke + '/revoke','POST',{reason:data.get('reason')});
      alertUser('Credential revoked.');
    } else if (form.id === 'share-form') {
      lastShare = await api('shares','POST',{credentials:[data.get('credential')],showName:data.has('showName')});
      alertUser('Share link created.');
    } else if (form.id === 'job-form') {
      await api('jobs','POST',{...Object.fromEntries(data),wage:Number(data.get('wage')),openings:Number(data.get('openings'))});
      alertUser('Job published.');
    } else if (form.dataset.apply) {
      await api('jobs/' + form.dataset.apply + '/apply','POST',{credentialId:data.get('credential') || null});
      alertUser('Application submitted.');
    }
    await refresh();
    await render();
  } catch (error) { alertUser(error.message); }
  finally { if (submit) submit.disabled = false; }
});

document.addEventListener('change', async event => {
  const control = event.target;
  try {
    if (control.id === 'role-select') {
      if (recording?.state === 'recording') recording.stop();
      role = control.value;
      sessionStorage.setItem('hunar.role',role);
      workspace = null;
      lastShare = null;
      uploadTarget = null;
      uploadRequest = null;
      voiceDraft = '';
      filters = {locality:'',trade:''};
      await refresh();
      if (role === 'teacher') { await loadPractice(); await syncPractice(true); }
      location.hash = ({worker:'home',reviewer:'review',employer:'employer',teacher:'school'})[role];
      await render({fetchJobs:true});
    }
    if (control.id === 'study-lang') {
      locale = languages.includes(control.value) ? control.value : 'en';
      localStorage.setItem('hunar.study.lang',locale);
      await render();
    }
    if (control.id === 'learner-select') {
      learner = control.value;
      studySyncNote = '';
      await loadPractice();
      await render();
    }
  } catch (error) { alertUser(error.message); }
});

document.addEventListener('click', async event => {
  const control = event.target.closest('button[data-action]');
  if (!control || control.disabled) return;
  const [action,id] = control.dataset.action.split(':');
  control.disabled = true;
  try {
    if (action === 'sign-in') { await signIn(config); return; }
    if (action === 'sign-out') { localStorage.removeItem('hunar.study.owner'); signOut(config); return; }
    if (action === 'download') {
      const response = await fetch('/pack.json',{cache:'no-store'});
      if (!response.ok) throw new Error('The pack could not be downloaded.');
      const content = await response.json();
      if (!validatePack(content)) throw new Error('The pack is incomplete. Try downloading it again.');
      await writeLocal('pack',content);
      await loadPractice();
      alertUser(offlineShellReady ? 'Practice is ready to use offline.' : 'Pack saved. Wait for the Ready offline label before disconnecting.');
    } else if (action === 'answer') {
      const answer = Number(id);
      if (savingAnswer || feedback || !question?.choices.includes(answer)) return;
      const answered = question;
      const graded = grade(progress,answered,answer);
      const owner = schoolOwner();
      const key = studyKey();
      savingAnswer = true;
      try {
        await recordAnswer(key,graded,{ id:crypto.randomUUID(),profileId:learner,questionId:answered.id,answer,
          version:pack.version,clientCreatedAt:new Date().toISOString(),deviceId,owner });
      } finally { savingAnswer = false; }
      if (key === studyKey() && answered === question) {
        progress = graded;
        feedback = {correct:answer === answered.answer};
        pending += 1;
      }
    } else if (action === 'next-question') {
      feedback = null;
      question = pickQuestion(pack,progress);
    } else if (action === 'sync') {
      await syncPractice();
    } else if (action === 'clear-learner') {
      if (savingAnswer || syncInFlight) throw new Error('Wait for the current answer or sync to finish.');
      if (!confirm('Clear this learner’s answers from this device? Unsent answers for this learner will be removed. Synced class records will stay.')) return;
      await clearLearner(schoolOwner(),learner);
      await loadPractice();
      studySyncNote = 'Local practice cleared for this learner.';
    } else if (action === 'upload-continue' || action === 'upload-revise') {
      if (uploadInFlight) return;
      uploadTarget = { id, mode:action === 'upload-continue' ? 'continue' : 'revise' };
      await render();
      document.querySelector('#upload-form input[type=file]')?.focus();
      return;
    } else if (action === 'upload-cancel') {
      if (uploadInFlight) return;
      uploadTarget = null;
    } else if (action === 'upload-discard') {
      if (uploadInFlight || !confirm('Discard this unfinished upload?')) return;
      await api('submissions/' + id,'DELETE');
      if (uploadTarget?.id === id) uploadTarget = null;
      await refresh();
      alertUser('Draft discarded.');
    } else if (action === 'fixture') {
      const consent = document.querySelector('#upload-form input[name=consent]');
      if (!consent.checked) { consent.focus(); throw new Error('Confirm reviewer access before uploading the sample.'); }
      const response = await fetch('/sample.mp4');
      if (!response.ok) throw new Error('Sample video unavailable.');
      await sendEvidence(new File([await response.blob()],'sample.mp4',{type:'video/mp4',lastModified:0}),true);
      return;
    } else if (action === 'video') {
      const response = await http('submissions/' + id + '/media');
      const player = document.createElement('video');
      if ((response.headers.get('Content-Type') || '').includes('application/json')) {
        player.src = (await response.json()).url;
      } else {
        player.src = URL.createObjectURL(await response.blob());
        blobUrls.push(player.src);
      }
      player.controls = true; player.className = 'media'; player.preload = 'metadata';
      document.getElementById('media-' + id)?.replaceChildren(player);
      return;
    } else if (action === 'voice') { await beginVoice(); return; }
    else if (action === 'speak') {
      const response = await http('voice/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:id})});
      const audio = document.createElement('audio');
      audio.src = URL.createObjectURL(await response.blob());
      blobUrls.push(audio.src);
      audio.controls = true;
      audio.setAttribute('aria-label','Listing audio');
      control.insertAdjacentElement('afterend',audio);
      await audio.play().catch(() => {});
      return;
    } else if (action === 'copy-share') {
      await navigator.clipboard.writeText(location.origin + '/#share/' + lastShare.token);
      alertUser('Link copied.');
      return;
    } else if (action === 'disable') {
      await api('shares/' + id,'DELETE');
      if (lastShare?.shareId === id) lastShare = null;
      await refresh();
      alertUser('Share link disabled.');
    } else if (action === 'close') {
      await api('jobs/' + id + '/close','POST');
      await refresh();
      alertUser('Listing closed.');
    } else if (['withdraw','shortlisted','declined'].includes(action)) {
      await api('applications/' + id,'POST',{status:action === 'withdraw' ? 'withdrawn' : action});
      await refresh();
      alertUser('Application updated.');
    }
    await render();
  } catch (error) { alertUser(error.message); }
  finally { control.disabled = false; }
});

window.addEventListener('hashchange', () => {
  if (location.hash === '#main') { main.focus(); return; }
  if (recording?.state === 'recording' && location.hash !== '#jobs') recording.stop();
  render({fetchJobs:true});
});
window.addEventListener('offline', () => { if (page === 'school') render(); });
window.addEventListener('online', async () => {
  await refresh();
  await syncPractice(true);
  await render({fetchJobs:true});
});

try {
  config = await fetch('/api/config',{cache:'no-store'}).then(r => r.ok ? r.json() : {});
  if (config.authUrl) await finishSignIn(config);
} catch (error) {
  if (navigator.onLine) alertUser(error.message);
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    offlineShellReady = Boolean(navigator.serviceWorker.controller);
    if (page === 'school') render();
  });
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
if (navigator.onLine && (config.demo || idToken())) await refresh();
await loadPractice().catch(() => { if (navigator.onLine) alertUser('This browser could not open offline storage.'); });
await syncPractice(true);
await render({fetchJobs:true});
