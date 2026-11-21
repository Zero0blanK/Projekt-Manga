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
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data: { aboutServer: { name: 'Suwayomi', version: 'fake' } } }));
});
server.listen(port, value('ip'), () => console.log('fake engine ready'));

const marker = path.join(root, 'crashed-once');
if (behaviour === 'crash-once' && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1');
  setTimeout(() => {
    console.error('fake engine: crashing');
    process.exit(3);
  }, 400);
}
process.on('SIGTERM', () => server.close(() => process.exit(0)));
