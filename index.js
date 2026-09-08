import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const GAME = 'tunguska';
const GAME_ID = '11447538180825';
const PORT = 8787;
const gateway = 'https://sparta-gw.battlelog.com/jsonrpc/pc/api';
const SESSION_COOKIE = 'cerser_session';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const sessions = new Map();

export function readableError(message) {
  if (message.includes('ServerNotRestartableException')) {
    return 'EA sunucuyu şu anda yeniden başlatamıyor. Aktif tur başladıktan sonra haritayı tekrar seçin. (ServerNotRestartableException)';
  }
  return message;
}

async function rpc(method, params, sessionId, endpoint = gateway) {
  const res = await fetch(`${endpoint}?${method}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { 'X-GatewaySession': sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: randomUUID() })
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(readableError(data.error?.message ?? `HTTP ${res.status}`));
  return data.result;
}

async function login({ sid, remid }) {
  const auth = new URL('https://accounts.ea.com/connect/auth');
  auth.search = new URLSearchParams({
    client_id: 'sparta-companion-web',
    response_type: 'code',
    prompt: 'none',
    redirect_uri: 'nucleus:rest'
  });
  const cookies = [`sid=${sid}`];
  if (remid) cookies.unshift(`remid=${remid}`);
  const authRes = await fetch(auth, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
    headers: { Cookie: cookies.join('; '), Accept: 'application/json' }
  });
  const code = (await authRes.json()).code;
  if (!code) throw new Error(`BF1 auth code alınamadı: HTTP ${authRes.status}`);

  const result = await rpc(
    'Companion.loginFromAuthCode',
    { code, redirectUri: 'nucleus:rest' },
    null,
    'https://companion-api.battlefield.com/jsonrpc/web/api'
  );
  const sessionId = result?.sessionId ?? result?.id;
  if (!sessionId) throw new Error('BF1 gateway session alınamadı.');
  return sessionId;
}

async function context(credentials) {
  let sessionId;
  try {
    sessionId = await login(credentials);
  } catch {
    const error = new Error('EA oturumu geçersiz veya süresi dolmuş. SID değerini yeniden girin.');
    error.statusCode = 401;
    throw error;
  }
  const details = await rpc('GameServer.getFullServerDetails', { game: GAME, gameId: GAME_ID }, sessionId);
  const serverId = String(details?.rspInfo?.server?.serverId ?? '');
  const persistedGameId = String(details?.rspInfo?.server?.persistedGameId ?? '');
  if (!serverId) throw new Error('Sunucu kaydında serverId bulunamadı.');
  const rsp = await rpc('RSP.getServerDetails', { game: GAME, serverId }, sessionId);
  return { sessionId, details, rsp, serverId, persistedGameId };
}

export function buildAction(action, input, ids) {
  if (action === 'map') {
    const levelIndex = Number(input.levelIndex);
    if (!Number.isInteger(levelIndex) || levelIndex < 0) throw new Error('Geçerli bir harita sıra numarası girin.');
    if (!ids.persistedGameId) throw new Error('persistedGameId bulunamadı.');
    return ['RSP.chooseLevel', { game: GAME, persistedGameId: ids.persistedGameId, levelIndex }];
  }

  if (action === 'update') {
    const current = ids.rsp?.serverSettings ?? {};
    const rotation = ids.rsp?.mapRotations?.[0] ?? {};
    const name = String(input.name ?? current.name ?? '').trim();
    const description = String(input.description ?? current.description ?? '');
    const message = String(input.message ?? current.message ?? '');
    const password = String(input.password ?? current.password ?? '');
    const bannerUrl = String(input.bannerUrl ?? current.bannerUrl ?? '');
    if (!name || Buffer.byteLength(name) > 64) throw new Error('Sunucu adı 1-64 bayt olmalı.');
    if (description.length > 256 || Buffer.byteLength(description) > 512) throw new Error('Açıklama en fazla 256 karakter ve 512 bayt olabilir.');
    const maps = JSON.parse(input.maps || JSON.stringify(rotation.maps ?? []));
    if (!Array.isArray(maps) || !maps.length || maps.some(x => !x?.gameMode || !x?.mapName)) {
      throw new Error('Harita rotasyonu geçersiz.');
    }
    const custom = input.customGameSettings || current.customGameSettings || '{}';
    JSON.parse(custom);
    return ['RSP.updateServer', {
      deviceIdMap: { machash: randomUUID() }, game: GAME, serverId: ids.serverId,
      bannerSettings: { bannerUrl, clearBanner: !bannerUrl },
      mapRotation: {
        maps, rotationType: rotation.rotationType ?? '', mod: rotation.mod ?? '32',
        name: rotation.name ?? '0', description: rotation.description ?? '',
        id: rotation.mapRotationId ?? rotation.id ?? '100'
      },
      serverSettings: {
        ...current, name, description, message, password, bannerUrl,
        customGameSettings: custom
      }
    }];
  }

  const personaId = String(input.personaId ?? '').trim();
  if (!/^\d{6,}$/.test(personaId)) throw new Error('Geçerli bir persona ID girin.');
  const common = { game: GAME, serverId: ids.serverId, personaId };
  const actions = {
    kick: ['RSP.kickPlayer', { game: GAME, gameId: GAME_ID, personaId, reason: input.reason || 'RULEVIOLATION' }],
    ban: ['RSP.addServerBan', common],
    unban: ['RSP.removeServerBan', common],
    'vip-add': ['RSP.addServerVip', common],
    'vip-remove': ['RSP.removeServerVip', common],
    'admin-add': ['RSP.addServerAdmin', common],
    'admin-remove': ['RSP.removeServerAdmin', common],
    move: ['RSP.movePlayer', {
      game: GAME, gameId: GAME_ID, personaId,
      teamId: Number(input.teamId), forceKill: true, moveParty: false
    }]
  };
  if (action === 'move' && ![1, 2].includes(actions.move[1].teamId)) throw new Error('Takım 1 veya 2 olmalı.');
  if (!actions[action]) throw new Error('Geçersiz işlem.');
  return actions[action];
}

export function validateEaCredentials(input) {
  const sid = String(input.sid ?? '').trim();
  const remid = String(input.remid ?? '').trim();
  if (!sid || sid.length > 4096 || /[;\r\n]/.test(sid)) throw new Error('Geçerli bir EA SID değeri girin.');
  if (remid.length > 4096 || /[;\r\n]/.test(remid)) throw new Error('REMID değeri geçersiz.');
  return { sid, remid };
}

function sameOrigin(req) {
  const protocol = req.headers['x-forwarded-proto']?.split(',')[0].trim() || 'http';
  return req.headers.origin === `${protocol}://${req.headers.host}`;
}

function credentialsFor(req) {
  const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    const error = new Error('EA bağlantısı gerekli.');
    error.statusCode = 401;
    throw error;
  }
  return session.credentials;
}

async function status(credentials) {
  const ctx = await context(credentials);
  const rsp = ctx.rsp;
  return {
    serverInfo: ctx.details?.serverInfo ?? {},
    owner: rsp?.owner ?? ctx.details?.rspInfo?.owner ?? {},
    adminList: rsp?.adminList ?? [],
    vipList: rsp?.vipList ?? [],
    bannedList: rsp?.bannedList ?? [],
    mapRotations: rsp?.mapRotations ?? [],
    server: rsp?.server ?? {},
    serverSettings: rsp?.serverSettings ?? {}
  };
}

async function players() {
  const url = new URL('https://api.gametools.network/bf1/players/');
  url.searchParams.set('gameid', GAME_ID);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Oyuncu listesi alınamadı: HTTP ${res.status}`);
  try { return JSON.parse(text); }
  catch { throw new Error('Oyuncu listesi geçerli JSON döndürmedi.'); }
}

function json(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100_000) throw new Error('İstek çok büyük.');
  }
  return JSON.parse(body || '{}');
}

export const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      const html = await readFile(new URL('ui.html', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && req.url === '/api/status') return json(res, 200, await status(credentialsFor(req)));
    if (req.method === 'GET' && req.url === '/api/players') {
      credentialsFor(req);
      return json(res, 200, await players());
    }
    if (req.method === 'POST' && req.url === '/api/auth') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Geçersiz istek kaynağı.' });
      const input = await readJson(req);
      if (input.consent !== true) return json(res, 400, { error: 'Devam etmek için bilgilendirmeyi kabul edin.' });
      const credentials = validateEaCredentials(input);
      await context(credentials);
      const token = randomUUID();
      sessions.set(token, { credentials, expiresAt: Date.now() + SESSION_TTL });
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}` });
    }
    if (req.method === 'POST' && req.url === '/api/action') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Geçersiz istek kaynağı.' });
      const input = await readJson(req);
      const ctx = await context(credentialsFor(req));
      const [method, params] = buildAction(input.action, input, ctx);
      const result = await rpc(method, params, ctx.sessionId);
      return json(res, 200, { ok: true, result });
    }
    json(res, 404, { error: 'Bulunamadı.' });
  } catch (error) {
    json(res, error.statusCode ?? 500, { error: error.message });
  }
});

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`BF1 yönetim ekranı: http://127.0.0.1:${PORT}`);
  });
}
