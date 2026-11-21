// A stand-in for the extension engine in tests, so they need no Java.
//
// Launched with the arguments the real engine gets (-Xmx, -D<root dir>, -jar <jar>), it
// reads the managed block of <root dir>/server.conf for its port and login and answers
// the GraphQL `aboutServer` query behind basic auth, as Suwayomi-Server does.
//
// The jar file's contents choose a behaviour, so a test can install a "broken" version:
//   "ok"          answers normally
//   "broken"      exits at once
//   "crash-once"  answers, then exits after a moment the first time (a marker file in the
//                 root dir remembers), and runs normally after
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const rootArg = args.find((arg) => /^-D.+\.server\.rootDir=/.test(arg));
const jar = args[args.indexOf('-jar') + 1];
if (!rootArg || !jar) {
  console.error('fake engine: missing root dir or jar');
  process.exit(2);
}
const root = rootArg.slice(rootArg.indexOf('=') + 1);
const behaviour = fs.readFileSync(jar, 'utf8').trim();

const conf = fs.readFileSync(path.join(root, 'server.conf'), 'utf8');
const value = (key) => {
  const matches = [...conf.matchAll(new RegExp(`^server\\.${key} = (.+)$`, 'gm'))];
  const last = matches.at(-1)?.[1];
  return last === undefined ? undefined : JSON.parse(last);
};
const port = value('port');
const expected = `Basic ${Buffer.from(`${value('authUsername')}:${value('authPassword')}`).toString('base64')}`;

console.log(`fake engine starting (${behaviour}) on ${value('ip')}:${port}`);
if (behaviour === 'broken') {
  console.error('fake engine: broken build');
  process.exit(1);
}

const server = http.createServer((request, response) => {
  if (request.headers.authorization !== expected) {
    response.writeHead(401).end();
    return;
  }
  if (request.method !== 'POST' || request.url !== '/api/graphql') {
    response.writeHead(404).end();
    return;
  }
  let raw = '';
  request.on('data', (chunk) => (raw += chunk));
  request.on('end', () => {
    const { query = '', variables = {} } = JSON.parse(raw || '{}');
    // Extension stores (repositories), kept in the data folder like Suwayomi's database.
    // An index URL containing "missing" answers like a repository that isn't there.
    const storesFile = path.join(root, 'fake-stores.json');
    const stores = () =>
      fs.existsSync(storesFile) ? JSON.parse(fs.readFileSync(storesFile, 'utf8')) : [];
    const save = (list) => fs.writeFileSync(storesFile, JSON.stringify(list));
    const reply = (body) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (query.includes('addExtensionStore')) {
      if (variables.url.includes('missing')) {
        reply({
          errors: [
            { message: 'HTTP error 404\n\norg.example.network.HttpException: HTTP error 404' },
          ],
        });
        return;
      }
      save([...stores(), { indexUrl: variables.url, name: 'Example repository' }]);
      reply({ data: { addExtensionStore: { extensionStore: { indexUrl: variables.url } } } });
    } else if (query.includes('removeExtensionStore')) {
      save(stores().filter((store) => store.indexUrl !== variables.url));
      reply({ data: { removeExtensionStore: { extensionStore: { indexUrl: variables.url } } } });
    } else if (query.includes('extensionStores')) {
      reply({ data: { extensionStores: { nodes: stores() } } });
    } else {
      reply({ data: { aboutServer: { name: 'Suwayomi', version: 'fake' } } });
    }
  });
});
server.listen(port, value('ip'), () => console.log('fake engine ready'));

// Like the engine's embedded browser: a helper process of its own, which must not outlive
// it. Its pid goes in the root dir for the test to check.
if (behaviour === 'with-helper') {
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  fs.writeFileSync(path.join(root, 'helper.pid'), String(helper.pid));
}

const marker = path.join(root, 'crashed-once');
if (behaviour === 'crash-once' && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1');
  setTimeout(() => {
    console.error('fake engine: crashing');
    process.exit(3);
  }, 400);
}
process.on('SIGTERM', () => server.close(() => process.exit(0)));
