// ============================================================================
// EHSR 调度器（Vercel 版，Node.js Runtime）
//
// 为什么在 Vercel：Modal 的 JS SDK 走 gRPC（nice-grpc），Cloudflare
// Workers 的运行时不支持 HTTP/2 双向流，SDK 在 Worker 里跑不起来；
// Vercel 的 Node.js Runtime 是完整 Node 进程，可以正常用 SDK 的
// getCurrentStats() 查每个账号的容器运行数。
//
// 派发逻辑：
//   1. 并行查每个账号：Modal stats（runner 数）+ Tunnel /health 探活。
//      stats 说「容器在跑」、探活说「tunnel + 服务都通」——两个都成立
//      才算这个后端能接活（runner 在跑但 cloudflared 死了照样不能用）。
//   2. 有能接活的 → 直接在它上面向后端签一个新会话，返回给客户端。
//   3. 有 runner 在跑但 tunnel 还没通（启动中）→ 返回 waking，客户端
//      轮询状态接口；超时仍不通则报错（容器在跑但 tunnel 不可达）。
//   4. 全都没在跑 → 按本月剩余额度（自记账本，见下）挑最高的账号，
//      打一发 /__wake 把它唤醒，返回 waking + dispatchId。
//   「同时只跑一个容器」靠 stats 保证：只要任何账号 runner>0 就绝不
//   再唤醒第二个；唤醒请求在状态轮询里会幂等补发，不怕第一发丢失。
//
// 额度账本：Modal 没有查账单/用量的 API，所以调度器自己记——每次和
// 活着的后端通信时，顺手取它 /__status 自报的本月 GPU 秒数存下来。
// 存储用 Vercel KV / Upstash Redis 的 REST 接口（环境变量
// KV_REST_API_URL + KV_REST_API_TOKEN，或 UPSTASH_REDIS_REST_URL +
// UPSTASH_REDIS_REST_TOKEN，连了存储会自动注入）。不配存储也能跑，
// 只是额度排序退化成按 ACCOUNT_1、ACCOUNT_2… 的顺序。
//
// dispatchId 是无状态签名令牌（HMAC，密钥复用 BACKEND_SECRET），
// 服务端不存派发记录，轮询时凭令牌里的账号 id 现查现判。
//
// 环境变量（Vercel 项目 Settings → Environment Variables）：
//   CLIENT_KEY      客户端请求头 X-Client-Key 要带的值，自己定
//   BACKEND_SECRET  与每个 Modal 后端 secret 里的 BACKEND_SECRET 一致
//   ACCOUNT_1、ACCOUNT_2 …（有几个账号配几个）每个是一段 JSON：
//     {"id":"acc1",
//      "tunnelBase":"https://ehsr-1.fur.boats",
//      "wakeBase":"https://<workspace>--jh-super-resolution.modal.run",
//      "monthlyCreditUsd":30,
//      "gpuRatePerSec":0.000164,
//      "modalTokenId":"ak-...",
//      "modalTokenSecret":"as-...",
//      "modalApp":"jh-super-resolution",
//      "modalFunction":"Backend",
//      "modalMethod":"serve"}
//     gpuRatePerSec：T4=0.000164，L4=0.000222，A10=0.000306
//     modalApp / modalFunction / modalMethod 可省略，默认就是上面这组值
//     （modalFunction 是 Cls 类名，modalMethod 是它的 web_server 方法名）。
//     modalTokenId/Secret：在 Modal 账号 Settings → API Tokens 里建。
//     不填 token 也能跑：stats 视为未知，全靠探活判断（退化为纯探活版）。
//
// 客户端接口（与 Worker 版完全一致，客户端不用区分宿主）：
//   POST /resolution_img            头 X-Client-Key
//     -> 200 {"state":"ready","backendUrl":"...","sessionId":"..."}
//     -> 202 {"state":"waking","dispatchId":"..."}
//   GET  /resolution_img/status?dispatchId=<令牌>   头同上
//     -> 200 {"state":"waking"}
//     -> 200 {"state":"ready","backendUrl":"...","sessionId":"..."}
//     -> 200 {"state":"error","error":"..."}
//   GET  /status?key=<CLIENT_KEY>   纯文本状态页（根路径直接 404，不公开）
// ============================================================================

const crypto = require('crypto');
const { ModalClient } = require('modal');

const WAKE_TIMEOUT_MS = 240_000; // 一次派发最多等 4 分钟
const TUNNEL_DEAD_MS = 150_000; // runner 在跑但 tunnel 超过这个时长还不通 -> 报错
const TOKEN_TTL_MS = 300_000;
const HEALTH_TIMEOUT_MS = 3_500;

// ---------------- 配置 ----------------

function loadAccounts() {
  const accounts = [];
  for (let i = 1; i <= 20; i++) {
    const raw = process.env[`ACCOUNT_${i}`];
    if (!raw) continue;
    try {
      const a = JSON.parse(raw);
      if (a && a.id && a.tunnelBase && a.wakeBase) accounts.push(a);
    } catch {
      /* 某个 ACCOUNT_n 写坏了就跳过它，别拖垮整个调度器 */
    }
  }
  return accounts;
}

// ---------------- 小工具 ----------------

function sendJson(res, status, data) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(data));
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', process.env.BACKEND_SECRET || '')
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto
    .createHmac('sha256', process.env.BACKEND_SECRET || '')
    .update(body)
    .digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (Date.now() - payload.iat > TOKEN_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------- KV（可选，REST 直调，无 SDK 依赖） ----------------

function kvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function kvGet(key) {
  const cfg = kvConfig();
  if (!cfg) return null;
  try {
    const resp = await fetch(`${cfg.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch {
    return null;
  }
}

async function kvSet(key, value) {
  const cfg = kvConfig();
  if (!cfg) return;
  try {
    await fetch(`${cfg.url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* 账本写失败不致命 */
  }
}

// ---------------- 额度账本 ----------------

async function remainingUsd(account) {
  const credit = Number(account.monthlyCreditUsd) || 30;
  const rate = Number(account.gpuRatePerSec) || 0.000164;
  const usage = await kvGet(`usage:${account.id}`);
  if (!usage || usage.month !== currentMonth()) return credit;
  return Math.max(0, credit - (Number(usage.gpuSeconds) || 0) * rate);
}

async function refreshUsageCache(account) {
  try {
    const resp = await fetch(`${account.wakeBase}/__status`, {
      headers: { 'X-Backend-Secret': process.env.BACKEND_SECRET || '' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (typeof data.gpuSecondsThisMonth === 'number') {
      await kvSet(`usage:${account.id}`, {
        month: currentMonth(),
        gpuSeconds: data.gpuSecondsThisMonth,
      });
    }
  } catch {
    /* 后端没应答就保留旧账本 */
  }
}

// ---------------- Modal stats / 探活 / 唤醒 / 签会话 ----------------

const lastStatsErrors = {}; // accountId -> 最近一次 stats 失败原因（状态页展示）

async function getRunners(account) {
  if (!account.modalTokenId || !account.modalTokenSecret) {
    lastStatsErrors[account.id] = '未配置 modal token';
    return null;
  }
  const appName = account.modalApp || 'jh-super-resolution';
  const base = account.modalFunction || 'Backend';
  const methodName = account.modalMethod || 'serve';
  let client;
  try {
    client = new ModalClient({
      tokenId: account.modalTokenId,
      tokenSecret: account.modalTokenSecret,
      timeoutMs: 15000,
      maxRetries: 1,
    });
    // 后端是 Modal 的 Cls：JS SDK 不许用 functions.fromName 取 Cls 方法，
    // 必须走 cls.fromName -> instance() -> method("serve")。
    // 普通函数部署时退回 functions.fromName。
    const attempts = [
      async () => {
        const cls = await client.cls.fromName(appName, base);
        const instance = await cls.instance();
        return instance.method(methodName);
      },
      async () => client.functions.fromName(appName, base),
    ];
    let lastErr = null;
    for (const attempt of attempts) {
      try {
        const fn = await attempt();
        const stats = await fn.getCurrentStats();
        if (stats && typeof stats.numTotalRunners === 'number') {
          delete lastStatsErrors[account.id];
          return stats.numTotalRunners;
        }
        lastErr = new Error('返回里没有 numTotalRunners');
      } catch (e) {
        lastErr = e;
      }
    }
    lastStatsErrors[account.id] = String((lastErr && lastErr.message) || lastErr || 'unknown error').slice(0, 300);
    return null; // 查不到就当未知，靠探活兜底
  } catch (e) {
    lastStatsErrors[account.id] = String((e && e.message) || e).slice(0, 300);
    return null;
  } finally {
    try {
      if (client) client.close();
    } catch {
      /* ignore */
    }
  }
}

async function isTunnelUp(account) {
  try {
    const resp = await fetch(`${account.tunnelBase}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function probe(account) {
  const [runners, up] = await Promise.all([getRunners(account), isTunnelUp(account)]);
  return { account, runners, up };
}

function fireWake(account) {
  // 请求打到 modal.run 入口本身就会把容器拉起来。这里只等几秒确认
  // 请求已送达就返回——容器在 Modal 侧会继续启动，状态轮询里还会
  // 幂等补发，所以第一发就算丢了也能自愈。
  return fetch(`${account.wakeBase}/__wake`, {
    method: 'POST',
    headers: { 'X-Backend-Secret': process.env.BACKEND_SECRET || '' },
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

async function mintSession(account) {
  const resp = await fetch(`${account.wakeBase}/__session`, {
    method: 'POST',
    headers: { 'X-Backend-Secret': process.env.BACKEND_SECRET || '' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`后端签发会话失败（HTTP ${resp.status}）`);
  const data = await resp.json();
  if (!data.sessionId) throw new Error('后端未返回 sessionId');
  return data.sessionId;
}

async function readyResult(account) {
  const sessionId = await mintSession(account);
  return { state: 'ready', backendUrl: account.tunnelBase, sessionId };
}

async function pickByQuota(accounts) {
  let best = accounts[0];
  let bestRemaining = -1;
  for (const a of accounts) {
    const r = await remainingUsd(a);
    if (r > bestRemaining) {
      bestRemaining = r;
      best = a;
    }
  }
  return best;
}

// ---------------- 派发 ----------------

async function createDispatch(res) {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    return sendJson(res, 500, { error: '调度器未配置账号池（ACCOUNT_1…）' });
  }

  const probed = await Promise.all(accounts.map(probe));

  // 1) 有能接活的（tunnel 通；runner 数能确认时要求 >0，查不到则以探活为准）
  const serving = probed.filter((p) => p.up && (p.runners === null || p.runners > 0));
  if (serving.length > 0) {
    let chosen = serving[0];
    if (serving.length > 1) {
      chosen = { account: await pickByQuota(serving.map((p) => p.account)) };
    }
    refreshUsageCache(chosen.account);
    try {
      return sendJson(res, 200, await readyResult(chosen.account));
    } catch (e) {
      return sendJson(res, 502, { error: String((e && e.message) || e) });
    }
  }

  // 2) 有 runner 在跑但 tunnel 还没通：在启动中（或 tunnel 故障）。
  //    绝不再唤醒第二个，挂在这台上等。
  const running = probed.filter((p) => p.runners !== null && p.runners > 0);
  if (running.length > 0) {
    const dispatchId = signToken({ accountId: running[0].account.id, iat: Date.now() });
    return sendJson(res, 202, { state: 'waking', dispatchId });
  }

  // 3) 全都没在跑（或 stats 未知且探活不通）：挑额度最高的唤醒。
  //    stats 未知时若其实已有容器在跑，/__wake 打过去也只是普通请求，无害。
  const best = await pickByQuota(accounts);
  await fireWake(best);
  const dispatchId = signToken({ accountId: best.id, iat: Date.now() });
  return sendJson(res, 202, { state: 'waking', dispatchId });
}

async function dispatchStatus(res, dispatchId) {
  const payload = verifyToken(dispatchId);
  if (!payload) {
    return sendJson(res, 200, { state: 'error', error: '派发令牌无效或已过期，请重新请求后端' });
  }
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === payload.accountId);
  if (!account) {
    return sendJson(res, 200, { state: 'error', error: '派发对应的账号已不在账号池里' });
  }
  const age = Date.now() - payload.iat;
  const { runners, up } = await probe(account);

  if (up && (runners === null || runners > 0)) {
    refreshUsageCache(account);
    try {
      return sendJson(res, 200, await readyResult(account));
    } catch (e) {
      return sendJson(res, 200, { state: 'error', error: String((e && e.message) || e) });
    }
  }

  if (runners !== null && runners > 0) {
    // 容器在跑但 tunnel 不通
    if (age > TUNNEL_DEAD_MS) {
      return sendJson(res, 200, {
        state: 'error',
        error: '容器在运行但 Tunnel 长时间不可达，请检查该账号的 cloudflared / Tunnel 配置',
      });
    }
    return sendJson(res, 200, { state: 'waking' });
  }

  // 还没起来：补发一发唤醒（幂等），继续等
  if (age > WAKE_TIMEOUT_MS) {
    return sendJson(res, 200, { state: 'error', error: '唤醒超时，后端未在预期时间内就绪' });
  }
  await fireWake(account);
  return sendJson(res, 200, { state: 'waking' });
}

// ---------------- 状态页 ----------------

async function rootPage(res) {
  const accounts = loadAccounts();
  const lines = [
    'EHSR scheduler (vercel)',
    `accounts configured: ${accounts.length}`,
    `kv bound: ${kvConfig() ? 'yes' : 'no'}`,
  ];
  const probed = await Promise.all(accounts.map(probe));
  for (const p of probed) {
    const r = await remainingUsd(p.account);
    let line = `- ${p.account.id}: runners=${p.runners === null ? '?' : p.runners} tunnel=${p.up ? 'up' : 'down'} remaining ≈ $${r.toFixed(2)} / $${Number(p.account.monthlyCreditUsd) || 30}`;
    if (p.runners === null && lastStatsErrors[p.account.id]) {
      line += ` statsError=${lastStatsErrors[p.account.id]}`;
    }
    lines.push(line);
  }
  res.status(200).setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n'));
}

// ---------------- 入口 ----------------

module.exports = async (req, res) => {
  const route = (req.query && req.query.route) || '';
  try {
    if (route === 'root' && req.method === 'GET') {
      // 状态页不公开：必须带 ?key=<CLIENT_KEY>，否则一律 404
      if (!process.env.CLIENT_KEY || req.query.key !== process.env.CLIENT_KEY) {
        return sendJson(res, 404, { error: 'not found' });
      }
      return await rootPage(res);
    }
    if (route === 'dispatch' || route === 'status') {
      if (!process.env.CLIENT_KEY) {
        return sendJson(res, 500, { error: '调度器未配置 CLIENT_KEY' });
      }
      if (req.headers['x-client-key'] !== process.env.CLIENT_KEY) {
        return sendJson(res, 401, { error: 'bad client key' });
      }
      if (route === 'dispatch' && req.method === 'POST') {
        return await createDispatch(res);
      }
      if (route === 'status' && req.method === 'GET') {
        return await dispatchStatus(res, req.query.dispatchId);
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { error: String((e && e.message) || e) });
  }
};
