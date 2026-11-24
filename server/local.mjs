import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { makeApi, accounts } from './api.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const freshDemo = process.argv.includes('--fresh');
const dataDir = freshDemo ? await mkdtemp(join(tmpdir(), 'hunar-demo-')) : resolve(process.env.HUNAR_DATA_DIR || join(root, '.data'));
await mkdir(join(dataDir, 'evidence'), { recursive: true });
const stateFile = join(dataDir, 'state.json');
let tail = Promise.resolve();

const db = {
  async read(initial) {
    try { return JSON.parse(await readFile(stateFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return initial();
      throw error;
    }
  },
  change(initial, fn) {
    const write = tail.then(async () => {
      const state = await db.read(initial);
      const result = fn(state);
      await writeFile(stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 });
      await rename(stateFile + '.tmp', stateFile);
      return result;
    });
    tail = write.catch(() => {});
    return write;
  }
};

const media = {
  prepare: async item => ({ url: '/api/submissions/' + item.id + '/media', mode: 'put' }),
  async put(item, bytes) {
    const webm = bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    const mp4 = ['ftyp','moov','mdat','wide','free'].includes(bytes.toString('ascii', 4, 8));
    if (!(item.type === 'video/webm' ? webm : mp4)) {
      throw Object.assign(new Error('This file does not look like an MP4, WebM or MOV video.'), { status:400 });
    }
    const key = join(dataDir, item.key);
    const version = createHash('sha256').update(bytes).digest('hex');
    const temp = key + '.' + randomUUID() + '.tmp';
    await writeFile(temp, bytes, { mode:0o600 });
    await rename(temp, key + '.' + version);
    await writeFile(temp, version, { mode:0o600 });
    await rename(temp, key + '.current');
  },
  async inspect(item) {
    const key = join(dataDir, item.key);
    let version = 'local';
    try {
      version = await readFile(key + '.current', 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return { size:(await stat(key + '.' + version)).size, type:item.type, version };
  },
  async play(item) {
    const path = join(dataDir, item.key) + (item.mediaVersion === 'local' ? '' : '.' + item.mediaVersion);
    return { status: 200, headers: { 'Content-Type': item.type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
      body: await readFile(path) };
  }
};

const api = makeApi({ db, media, demo: true });
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4'
};

const web = createServer(async (req, res) => {
  const rawPath = req.url || '/';
  const pathname = new URL(rawPath, 'http://localhost').pathname;
  const reply = ({ status, headers, body }) => {
    res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  try {
    if (pathname.startsWith('/api/')) {
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) {
        return reply({ status: 403, body: 'Cross-site requests are disabled.' });
      }
      const pieces = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 21 * 1024 * 1024) return reply({ status: 413, body: 'Upload is too large.' });
        pieces.push(chunk);
      }
      const role = req.headers['x-hunar-demo-role'];
      const actor = Object.hasOwn(accounts, role) ? accounts[role] : null;
      return reply(await api({ path: rawPath, method: req.method, headers: req.headers, actor, body: Buffer.concat(pieces) }));
    }
    const name = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) return reply({ status: 404, body: 'Not found' });
    const type = types[extname(name)];
    if (!type) return reply({ status: 404, body: 'Not found' });
    return reply({ status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' }, body: await readFile(join(root, 'public', name)) });
  } catch (error) {
    reply({ status: error.code === 'ENOENT' ? 404 : 500, body: 'Unable to load this resource.' });
  }
});
if (freshDemo) {
  for (const signal of ['SIGINT','SIGTERM']) {
    process.once(signal, () => web.close(async () => {
      await rm(dataDir, { recursive:true, force:true });
      process.exit(0);
    }));
  }
}

web.listen(Number(process.env.PORT || (freshDemo ? 4175 : 4173)), '127.0.0.1', () => {
  console.log('Hunar is running at http://127.0.0.1:' + web.address().port);
  if (freshDemo) console.log('Fresh demo data is isolated from your usual workspace.');
});
