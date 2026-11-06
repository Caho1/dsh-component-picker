/**
 * Host half of the browser element picker.
 *
 * Installed bundle client halves get no `harness` RPC bridge (the module loader
 * calls `factory(require)` only), so the pair talks over the one channel both
 * sides really have: an exact HTTP route on the Host web server, called by the
 * page with a same-origin `fetch`.
 *
 *   GET  /component-picker/state  → { ok: true }        (capability probe)
 *   POST /component-picker/stage  → { ok: true }        (inject the context)
 *
 * `stage` calls `agent.inject()`, so the picked element reaches the model as a
 * model-facing context message instead of polluting the user's prompt text.
 */

const STATE_PATH = '/component-picker/state';
const STAGE_PATH = '/component-picker/stage';

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameOrigin(req, expected) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetch may omit it in some UAs
  try {
    const parsed = new URL(origin);
    const host = req.headers.host;
    if (host && parsed.host === host) return true;
    /* 127.0.0.1 / localhost / [::1] all reach the same listener. */
    const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
    const requestHost = host ? String(host).split(':')[0] : '';
    if (loopback.has(parsed.hostname) && loopback.has(requestHost)) return true;
    return expected ? parsed.origin === expected : false;
  } catch (error) {
    return false;
  }
}

/** The routes need the HTTP carrier, so the fiber waits for it. */
export const inject = ['webServer'];

const boots = [];

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  const server = ctx.webServer;
  if (!server || typeof server.register !== 'function') return;

  let origin = '';
  try {
    origin = server.getOrigin();
  } catch (error) {
    origin = '';
  }

  ctx.effect(() =>
    server.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (req, res) => {
        try {
          const url = new URL(req.url || STATE_PATH, 'http://127.0.0.1');
          const boot = url.searchParams.get('boot');
          if (boot) {
            boots.push({ at: Date.now(), ...JSON.parse(boot) });
            if (boots.length > 20) boots.shift();
          }
        } catch (error) {
          /* ignore malformed diagnostics */
        }
        send(res, 200, { ok: true, boots });
      },
    }),
  );

  ctx.effect(() =>
    server.register({
      kind: 'exact',
      path: STAGE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, reason: 'method' });
          return;
        }
        if (origin && !sameOrigin(req, origin)) {
          send(res, 403, { ok: false, reason: 'origin' });
          return;
        }
        let body;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch (error) {
          send(res, 400, { ok: false, reason: 'bad-json' });
          return;
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const text = typeof body.text === 'string' ? body.text : '';
        if (!sessionId || !text) {
          send(res, 400, { ok: false, reason: 'bad-args' });
          return;
        }

        let agent;
        try {
          const agents = ctx.get('agents');
          agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
        } catch (error) {
          agent = undefined;
        }
        if (!agent || typeof agent.inject !== 'function') {
          send(res, 404, { ok: false, reason: 'no-agent' });
          return;
        }

        const summary = typeof body.summary === 'string' && body.summary
          ? body.summary.slice(0, 120)
          : 'Selected element on the page';
        const message = {
          id: `component-picker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'component-picker', form: 'notice', summary },
        };
        try {
          /* next-turn + no wake: the row shows in the flow as an input entry and
             waits for the user's own prompt. `inject()` would land in the step's
             collapsed process area instead. */
          if (typeof agent.send === 'function') agent.send(message, 'next-turn', false);
          else agent.inject(message);
        } catch (error) {
          send(res, 500, { ok: false, reason: 'inject-failed' });
          return;
        }
        send(res, 200, { ok: true });
      },
    }),
  );
}
