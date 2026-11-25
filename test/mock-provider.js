// A local stand-in for the Anthropic and OpenAI-compatible APIs the summarizer calls.
// Each URL prefix (e.g. /good, /down) gets its own list of behaviours, used one per request
// (the last one repeats): 'ok' | 'garbage' | 'hang' | { status, body }.
import http from 'node:http';

export const REPLY = {
  task: { title: 'Fix prorate' },
  completed: ['swapped the division in prorate()'],
  next_action: 'Fix the rounding in prorate() so test/billing.test.js passes',
  tests: { command: 'npm test', result: 'fail' },
};

export function mockProvider(routes) {
  const seen = [];
  const counts = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const prefix = '/' + req.url.split('/')[1];
      const list = routes[prefix] ?? ['ok'];
      const n = (counts[prefix] = (counts[prefix] ?? 0) + 1);
      const how = list[n - 1] ?? list.at(-1);
      seen.push({ prefix, url: req.url, headers: req.headers, body });
      if (how === 'hang') return; // never answers: the client must time out
      res.setHeader('content-type', 'application/json');
      if (how === 'garbage') return res.end('{"choices": [ not json');
      if (typeof how === 'object') {
        res.statusCode = how.status;
        return res.end(JSON.stringify(how.body ?? { error: { message: `mock ${how.status}` } }));
      }
      const text = '```json\n' + JSON.stringify(REPLY) + '\n```';
      res.end(JSON.stringify(req.url.endsWith('/v1/messages') ? { content: [{ type: 'text', text }] } : { choices: [{ message: { content: text } }] }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seen,
        close: () => new Promise((r) => {
          server.closeAllConnections();
          server.close(r);
        }),
      }),
    ),
  );
}
