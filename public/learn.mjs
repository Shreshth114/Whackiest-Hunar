let database;
const db = () => {
  if (!database) database = new Promise((resolve, reject) => {
    const open = indexedDB.open('hunar-public-learning', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('records');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => resolve(open.result);
  });
  return database;
};

async function rw(mode, operation) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction('records', mode);
    const request = operation(tx.objectStore('records'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export const readLocal = key => rw('readonly', store => store.get(key));
export const writeLocal = (key, value) => rw('readwrite', store => store.put(value, key));
export const removeLocal = key => rw('readwrite', store => store.delete(key));

export async function recordAnswer(profile, progress, event) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    store.put(progress, 'progress:' + profile);
    store.put(event, 'event:' + event.id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export async function eventsFor(owner) {
  const rows = await rw('readonly', store => store.getAll(IDBKeyRange.bound('event:', 'event:\uffff')));
  return rows.filter(row => row.owner === owner);
}

export async function clearLearner(owner, profileId) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction('records','readwrite');
    const store = tx.objectStore('records');
    store.delete('progress:' + owner + ':' + profileId);
    const request = store.openCursor(IDBKeyRange.bound('event:', 'event:\uffff'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value.owner === owner && cursor.value.profileId === profileId) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function validatePack(pack) {
  if (pack?.id !== 'numeracy' || !Number.isInteger(pack.version) || pack.version < 1 ||
      !Array.isArray(pack.questions)) return false;
  const ids = new Set();
  const counts = [0,0,0,0];
  for (const q of pack.questions) {
    if (!q || typeof q.id !== 'string' || !q.id || ids.has(q.id) || ![1,2,3].includes(q.level) ||
        !['en','hi','why','whyHi'].every(field => typeof q[field] === 'string' && q[field].trim()) ||
        !Array.isArray(q.choices) || q.choices.length < 2 || !q.choices.every(Number.isFinite) ||
        new Set(q.choices).size !== q.choices.length || !q.choices.includes(q.answer)) return false;
    ids.add(q.id);
    counts[q.level]++;
  }
  return counts.slice(1).every(count => count >= 2);
}

export const startProgress = { level: 1, streak: 0, answered: 0, correct: 0, recent: [] };
export function pickQuestion(pack, progress) {
  const pool = pack.questions.filter(q => q.level === progress.level);
  return pool.find(q => !progress.recent.includes(q.id)) || pool.find(q => q.id !== progress.recent.at(-1)) || pool[0];
}

export function grade(progress, question, answer) {
  const correct = question.answer === answer;
  let streak = correct ? progress.streak + 1 : 0;
  let level = progress.level;
  if (streak >= 2) { level = Math.min(3, level + 1); streak = 0; }
  if (!correct) level = Math.max(1, level - 1);
  return { level, streak, answered: progress.answered + 1, correct: progress.correct + Number(correct),
    recent: [...progress.recent.slice(-2), question.id] };
}
