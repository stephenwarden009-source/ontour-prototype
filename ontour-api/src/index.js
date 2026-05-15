// ontour-api — Cloudflare Worker
// Routes: /health  /api/tm/:tourId  /api/subscribe  /api/push/test
// Scheduled: cron every 4h for change detection + push dispatch

const PAGES_ORIGIN = 'https://stephenwarden009-source.github.io';

const CORS = {
  'Access-Control-Allow-Origin': PAGES_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TOUR_MAP = {
  'styles-2026': { keyword: 'Harry Styles' },
  'rush-2026':   { keyword: 'Rush' },
  'bruno-2026':  { keyword: 'Bruno Mars' },
};

const ICON_URL = `${PAGES_ORIGIN}/ontour-private/icons/icon-192.png`;
const APP_URL  = `${PAGES_ORIGIN}/ontour-private/`;

// =============================================================================
// FETCH HANDLER
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health')
      return handleHealth();

    if (path.startsWith('/api/tm/'))
      return handleTMProxy(path.slice(8), url, env, ctx);

    if (path === '/api/subscribe' && request.method === 'POST')
      return handleSubscribe(request, env);

    if (path === '/api/push/test' && request.method === 'POST')
      return handlePushTest(request, env);

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(detectChanges(env));
  },
};

// =============================================================================
// HEALTH
// =============================================================================

function handleHealth() {
  return json({ ok: true, ts: new Date().toISOString() });
}

// =============================================================================
// TM PROXY
// =============================================================================

async function handleTMProxy(tourId, url, env, ctx) {
  const tour = TOUR_MAP[tourId];
  if (!tour) return json({ error: 'Unknown tour' }, 404);

  const city = url.searchParams.get('city') || '';
  const size = url.searchParams.get('size') || '40';
  const cacheKey = `https://cache.ontour/tm/${tourId}?city=${city}&size=${size}`;

  const cached = await caches.default.match(cacheKey);
  if (cached) return addCors(cached);

  const params = new URLSearchParams({
    apikey: env.TICKETMASTER_API_KEY,
    keyword: tour.keyword,
    classificationName: 'music',
    sort: 'date,asc',
    size,
    countryCode: 'US,CA',
  });
  if (city) params.set('city', city);

  try {
    const tmResp = await fetch(
      `https://app.ticketmaster.com/discovery/v2/events.json?${params}`
    );
    const data = await tmResp.json();
    const events = data?._embedded?.events || [];

    const response = json({ ok: true, tourId, events, fetchedAt: new Date().toISOString() });
    // Cache 5 min
    ctx.waitUntil(
      caches.default.put(cacheKey,
        new Response(response.clone().body, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' }
        })
      )
    );
    return addCors(response);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

// =============================================================================
// SUBSCRIBE
// =============================================================================

async function handleSubscribe(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const { subscription, followed_tours, name, home_city, consented_at } = body;

  if (!subscription?.endpoint)  return json({ ok: false, error: 'Missing push subscription' }, 400);
  if (!followed_tours?.length)  return json({ ok: false, error: 'Must follow at least one tour' }, 400);
  if (!consented_at)            return json({ ok: false, error: 'Missing consent timestamp' }, 400);

  const fields = [
    'travel_markets','travel_mode','package_open','trip_budget',
    'premium_open','premium_types','premium_spend','annual_membership',
    'membership_tier','membership_venues','alert_scope',
  ];
  const vals = fields.map(f => body[f] || null);

  try {
    const result = await env.DB.prepare(`
      INSERT INTO subscribers (
        push_endpoint, push_p256dh, push_auth,
        name, home_city, followed_tours, consented_at,
        travel_markets, travel_mode, package_open, trip_budget,
        premium_open, premium_types, premium_spend, annual_membership,
        membership_tier, membership_venues, alert_scope, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(push_endpoint) DO UPDATE SET
        push_p256dh    = excluded.push_p256dh,
        push_auth      = excluded.push_auth,
        followed_tours = excluded.followed_tours,
        last_push_sent = NULL
    `).bind(
      subscription.endpoint,
      subscription.keys?.p256dh || '',
      subscription.keys?.auth   || '',
      name || null,
      home_city || null,
      JSON.stringify(followed_tours),
      consented_at,
      ...vals,
      new Date().toISOString()
    ).run();

    const subscriberId = result.meta.last_row_id;

    // Welcome push (non-fatal if it fails)
    const tourNames = followed_tours.map(id => TOUR_MAP[id]?.keyword || id).join(', ');
    sendWebPush(env, subscription, {
      title: 'Welcome to onTour',
      body:  `You're following ${tourNames}. We'll only notify you when something material happens.`,
      icon:  ICON_URL,
      tag:   'welcome',
      url:   APP_URL,
    }).catch(err => console.error('Welcome push failed:', err));

    return json({ ok: true, subscriber_id: subscriberId });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

// =============================================================================
// PUSH TEST
// =============================================================================

async function handlePushTest(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const { subscriber_id, title, body: msgBody } = body;
  if (!subscriber_id) return json({ ok: false, error: 'Missing subscriber_id' }, 400);

  const sub = await env.DB.prepare(
    'SELECT * FROM subscribers WHERE id = ?'
  ).bind(subscriber_id).first();

  if (!sub) return json({ ok: false, error: 'Subscriber not found' }, 404);

  try {
    const status = await sendWebPush(env, {
      endpoint: sub.push_endpoint,
      keys: { p256dh: sub.push_p256dh, auth: sub.push_auth },
    }, {
      title: title   || 'onTour Test',
      body:  msgBody || 'Test notification from onTour',
      tag:   'test',
      url:   APP_URL,
    });
    return json({ ok: true, status });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

// =============================================================================
// SCHEDULED — CHANGE DETECTION
// =============================================================================

async function detectChanges(env) {
  for (const tourId of Object.keys(TOUR_MAP)) {
    try { await checkTour(tourId, env); }
    catch (err) { console.error(`checkTour ${tourId}:`, err); }
  }
}

async function checkTour(tourId, env) {
  const { keyword } = TOUR_MAP[tourId];
  const params = new URLSearchParams({
    apikey: env.TICKETMASTER_API_KEY,
    keyword,
    classificationName: 'music',
    sort: 'date,asc',
    size: '50',
    countryCode: 'US,CA',
  });

  const tmResp = await fetch(
    `https://app.ticketmaster.com/discovery/v2/events.json?${params}`
  );
  const data = await tmResp.json();
  const current = (data?._embedded?.events || []).map(normEvent);

  const snap = await env.DB.prepare(
    'SELECT snapshot_json FROM tour_snapshots WHERE tour_id = ?'
  ).bind(tourId).first();

  const previous = snap ? JSON.parse(snap.snapshot_json) : null;

  await env.DB.prepare(`
    INSERT INTO tour_snapshots (tour_id, snapshot_json, checked_at)
    VALUES (?,?,?)
    ON CONFLICT(tour_id) DO UPDATE SET
      snapshot_json = excluded.snapshot_json,
      checked_at    = excluded.checked_at
  `).bind(tourId, JSON.stringify(current), new Date().toISOString()).run();

  if (!previous) return; // first run

  for (const change of diffEvents(previous, current)) {
    await dispatchPush(env, tourId, change);
  }
}

function normEvent(e) {
  return {
    id:          e.id,
    name:        e.name,
    date:        e.dates?.start?.localDate,
    status:      e.dates?.status?.code,
    venue:       e._embedded?.venues?.[0]?.name,
    city:        e._embedded?.venues?.[0]?.city?.name,
    onSaleDate:  e.sales?.public?.startDateTime,
    onSaleTBD:   e.sales?.public?.startTBD,
    url:         e.url,
  };
}

function diffEvents(prev, curr) {
  const changes = [];
  const prevMap = Object.fromEntries(prev.map(e => [e.id, e]));
  const currMap = Object.fromEntries(curr.map(e => [e.id, e]));

  for (const [id, e] of Object.entries(currMap)) {
    if (!prevMap[id]) {
      changes.push({ type: 'new_date',
        title: 'New Tour Date',
        body:  `${e.venue}, ${e.city} — ${e.date || 'date TBA'}` });
      continue;
    }
    const p = prevMap[id];
    if (p.status !== e.status)
      changes.push({ type: 'status_change',
        title: 'Ticket Status Changed',
        body:  `${e.venue}, ${e.city}: ${p.status} → ${e.status}` });
    if (p.onSaleDate !== e.onSaleDate && e.onSaleDate && !e.onSaleTBD)
      changes.push({ type: 'onsale_change',
        title: 'On-Sale Date Confirmed',
        body:  `${e.venue}, ${e.city} — on sale ${e.onSaleDate}` });
  }
  return changes;
}

async function dispatchPush(env, tourId, change) {
  const subs = await env.DB.prepare(`
    SELECT id, push_endpoint, push_p256dh, push_auth, followed_tours
    FROM subscribers WHERE push_failures < 3
  `).all();

  for (const sub of subs.results) {
    if (!JSON.parse(sub.followed_tours || '[]').includes(tourId)) continue;

    const recent = await env.DB.prepare(`
      SELECT id FROM push_log
      WHERE subscriber_id=? AND tour_id=? AND change_type=?
        AND sent_at > datetime('now','-24 hours')
    `).bind(sub.id, tourId, change.type).first();
    if (recent) continue;

    const subscription = {
      endpoint: sub.push_endpoint,
      keys: { p256dh: sub.push_p256dh, auth: sub.push_auth },
    };

    let status = 'sent', responseCode = 201;
    try {
      responseCode = await sendWebPush(env, subscription, {
        title: change.title,
        body:  change.body,
        tag:   `${tourId}-${change.type}`,
        icon:  ICON_URL,
        url:   APP_URL,
      });
      if (responseCode === 404 || responseCode === 410) {
        status = 'failed_expired';
        await env.DB.prepare(
          'UPDATE subscribers SET push_failures = push_failures + 1 WHERE id = ?'
        ).bind(sub.id).run();
      }
    } catch (err) {
      status = 'failed'; responseCode = 0;
      await env.DB.prepare(
        'UPDATE subscribers SET push_failures = push_failures + 1 WHERE id = ?'
      ).bind(sub.id).run();
    }

    await env.DB.prepare(`
      INSERT INTO push_log
        (subscriber_id, tour_id, change_type, payload_json, status, response_code, sent_at)
      VALUES (?,?,?,?,?,?,?)
    `).bind(sub.id, tourId, change.type, JSON.stringify(change),
            status, responseCode, new Date().toISOString()).run();

    if (status === 'sent')
      await env.DB.prepare(
        'UPDATE subscribers SET last_push_sent = ? WHERE id = ?'
      ).bind(new Date().toISOString(), sub.id).run();
  }
}

// =============================================================================
// WEB PUSH — RFC 8291 + RFC 8292 (Web Crypto API, no npm deps)
// =============================================================================

async function sendWebPush(env, subscription, payload) {
  const { ciphertext, salt, serverPublicKey } = await encryptPayload(
    subscription, JSON.stringify(payload)
  );

  // aes128gcm record: salt(16) || rs(4 BE) || idlen(1) || keyid(65) || ciphertext
  const record = new Uint8Array(16 + 4 + 1 + 65 + ciphertext.length);
  record.set(salt, 0);
  new DataView(record.buffer).setUint32(16, 4096, false);
  record[20] = 65;
  record.set(serverPublicKey, 21);
  record.set(ciphertext, 86);

  const audience    = new URL(subscription.endpoint).origin;
  const authHeader  = await buildVAPIDHeader(env, audience);

  const resp = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
      'Authorization':     authHeader,
    },
    body: record,
  });
  return resp.status;
}

async function encryptPayload(subscription, payloadStr) {
  const enc   = new TextEncoder();
  const plain = enc.encode(payloadStr);

  // Append padding delimiter 0x02
  const padded = new Uint8Array(plain.length + 1);
  padded.set(plain);
  padded[plain.length] = 0x02;

  const uaPublic   = b64uDecode(subscription.keys.p256dh);
  const authSecret = b64uDecode(subscription.keys.auth);

  // Ephemeral server key pair
  const serverKP = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverKP.publicKey)
  );

  // ECDH
  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, serverKP.privateKey, 256)
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Stage 1: IKM = HKDF(salt=authSecret, ikm=ecdhSecret, info="WebPush: info\0"+ua+as, 32)
  const keyInfo = concat(enc.encode('WebPush: info\x00'), uaPublic, asPublic);
  const ikm     = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // Stage 2: CEK and nonce from salt + IKM
  const cek   = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\x00'),     12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded)
  );

  return { ciphertext, salt, serverPublicKey: asPublic };
}

async function buildVAPIDHeader(env, audience) {
  const pubKeyB64u = env.VAPID_PUBLIC_KEY;
  const pubBytes   = b64uDecode(pubKeyB64u);

  // Build JWK from raw private key + public key coordinates
  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: env.VAPID_PRIVATE_KEY,
    x: b64uEncode(pubBytes.slice(1, 33)),
    y: b64uEncode(pubBytes.slice(33, 65)),
    key_ops: ['sign'],
  };
  const privateKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );

  const header  = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + 43200, sub: env.VAPID_SUBJECT };
  const enc     = new TextEncoder();
  const toBE    = obj => b64uEncode(enc.encode(JSON.stringify(obj)));
  const sigInput = `${toBE(header)}.${toBE(payload)}`;

  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(sigInput))
  );
  const jwt = `${sigInput}.${b64uEncode(sig)}`;

  return `vapid t=${jwt},k=${pubKeyB64u}`;
}

// =============================================================================
// HELPERS
// =============================================================================

async function hkdf(salt, ikm, info, length) {
  const key  = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8
  );
  return new Uint8Array(bits);
}

function b64uDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

function b64uEncode(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let i = 0;
  for (const a of arrays) { out.set(a, i); i += a.length; }
  return out;
}

function addCors(response) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
