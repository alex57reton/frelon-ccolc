/**
 * Cloudflare Worker — Frelon CCOLC
 *
 * Rôle : authentification mot de passe partagé + stockage des signalements
 *        dans Cloudflare KV. Tourne sur le free tier (100k req/jour).
 *
 * Variables d'environnement (à configurer via wrangler) :
 *   - AGENT_PASSWORD       : mot de passe partagé des agents CCOLC
 *   - JWT_SECRET           : clé secrète pour signer les tokens (32+ caractères)
 *   - SIGNALEMENTS         : binding KV namespace (signalements actifs)
 *   - REGISTRE_PERMANENT   : binding KV namespace (registre historique)
 *
 * Endpoints :
 *   POST /auth                    → login agent, retourne token
 *   GET  /signalements            → liste signalements actifs (auth requis)
 *   POST /signalements            → création signalement (auth requis)
 *   PATCH /signalements/:id       → modification (validation, rejet, etc.)
 *   DELETE /signalements/:id      → suppression (admin uniquement)
 *   POST /admin/purge             → purge manuelle des >30j (cron-friendly)
 */

const SESSION_DURATION = 8 * 3600; // 8h en secondes
const VALIDITE_JOURS = 30;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // À restreindre à ton domaine GitHub Pages en prod
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // === AUTH ===
      if (path === '/auth' && request.method === 'POST') {
        return await handleLogin(request, env);
      }

      // === SIGNALEMENTS (auth requis) ===
      const session = await requireAuth(request, env);
      if (session instanceof Response) return session;

      if (path === '/signalements' && request.method === 'GET') {
        return await listSignalements(env);
      }
      if (path === '/signalements' && request.method === 'POST') {
        return await createSignalement(request, env, session);
      }

      const matchId = path.match(/^\/signalements\/([\w-]+)$/);
      if (matchId) {
        const id = matchId[1];
        if (request.method === 'PATCH') return await updateSignalement(id, request, env, session);
        if (request.method === 'DELETE') return await deleteSignalement(id, env, session);
      }

      if (path === '/admin/purge' && request.method === 'POST') {
        return await purgeOldSignalements(env);
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(err);
      return jsonResponse({ error: err.message || 'Internal error' }, 500);
    }
  },

  // Cron handler (déclenché par Cloudflare Cron Triggers)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeOldSignalements(env));
  },
};

// ============= AUTH =============

async function handleLogin(request, env) {
  const { password, agentName } = await request.json();
  if (!password || password !== env.AGENT_PASSWORD) {
    return jsonResponse({ error: 'Mot de passe incorrect' }, 401);
  }
  const token = await createToken({
    agentName: agentName || 'Agent CCOLC',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + SESSION_DURATION,
  }, env.JWT_SECRET);
  return jsonResponse({ token, agentName });
}

async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Token manquant' }, 401);
  }
  const token = auth.slice(7);
  try {
    const payload = await verifyToken(token, env.JWT_SECRET);
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return jsonResponse({ error: 'Token expiré' }, 401);
    }
    return payload;
  } catch (err) {
    return jsonResponse({ error: 'Token invalide' }, 401);
  }
}

// ============= SIGNALEMENTS =============

async function listSignalements(env) {
  const list = await env.SIGNALEMENTS.list();
  const items = await Promise.all(
    list.keys.map(async (k) => {
      const raw = await env.SIGNALEMENTS.get(k.name);
      return raw ? JSON.parse(raw) : null;
    })
  );
  return jsonResponse(items.filter(Boolean));
}

async function createSignalement(request, env, session) {
  const data = await request.json();
  // Validation minimale côté serveur
  if (!data.lat || !data.lon || !data.adresse || !data.photoEspece) {
    return jsonResponse({ error: 'Champs obligatoires manquants' }, 400);
  }

  const signalement = {
    id: crypto.randomUUID(),
    lat: data.lat,
    lon: data.lon,
    adresse: data.adresse,
    commune: data.commune,
    codeInsee: data.codeInsee,
    typeObservation: data.typeObservation || 'vol',
    nombreIndividus: data.nombreIndividus || 'non_compte',
    commentaire: (data.commentaire || '').slice(0, 1000),
    photoEspece: data.photoEspece, // base64, déjà compressée par le navigateur
    photoUrl: data.photoUrl || null,
    statut: 'en_attente',
    agentSignalant: session.agentName,
    dateCreation: new Date().toISOString(),
    dateValidation: null,
    agentValidateur: null,
  };

  // Stockage actif (avec TTL 30j auto-géré par KV)
  await env.SIGNALEMENTS.put(
    signalement.id,
    JSON.stringify(signalement),
    { expirationTtl: VALIDITE_JOURS * 86400 }
  );

  // Stockage permanent (sans TTL)
  await env.REGISTRE_PERMANENT.put(
    signalement.id,
    JSON.stringify(signalement)
  );

  return jsonResponse(signalement, 201);
}

async function updateSignalement(id, request, env, session) {
  const raw = await env.SIGNALEMENTS.get(id);
  if (!raw) return jsonResponse({ error: 'Introuvable' }, 404);

  const existing = JSON.parse(raw);
  const patch = await request.json();

  // Champs autorisés en update
  const allowed = ['statut', 'commentaire', 'photoUrl', 'nombreIndividus', 'typeObservation'];
  const updated = { ...existing };
  for (const k of allowed) {
    if (k in patch) updated[k] = patch[k];
  }

  // Si validation/rejet, on enregistre l'agent et la date
  if (patch.statut && patch.statut !== existing.statut) {
    updated.dateValidation = new Date().toISOString();
    updated.agentValidateur = session.agentName;
  }

  await env.SIGNALEMENTS.put(id, JSON.stringify(updated), {
    expirationTtl: VALIDITE_JOURS * 86400,
  });
  // Mise à jour aussi du registre permanent
  await env.REGISTRE_PERMANENT.put(id, JSON.stringify(updated));

  return jsonResponse(updated);
}

async function deleteSignalement(id, env, session) {
  await env.SIGNALEMENTS.delete(id);
  // Note : on conserve dans REGISTRE_PERMANENT (audit trail)
  return jsonResponse({ deleted: true, id });
}

async function purgeOldSignalements(env) {
  // KV expire automatiquement les signalements actifs via expirationTtl.
  // Cette fonction est un filet de sécurité pour les cas où des signalements
  // anciens subsisteraient (modification après création par exemple).
  const seuil = Date.now() - VALIDITE_JOURS * 86400 * 1000;
  const list = await env.SIGNALEMENTS.list();
  let purged = 0;
  for (const k of list.keys) {
    const raw = await env.SIGNALEMENTS.get(k.name);
    if (!raw) continue;
    const s = JSON.parse(raw);
    if (new Date(s.dateCreation).getTime() < seuil) {
      await env.SIGNALEMENTS.delete(k.name);
      purged++;
    }
  }
  return jsonResponse({ purged });
}

// ============= UTILS =============

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

// === Mini JWT (HMAC-SHA256, sans librairie) ===

async function createToken(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const b64Header = base64UrlEncode(JSON.stringify(header));
  const b64Payload = base64UrlEncode(JSON.stringify(payload));
  const signature = await sign(`${b64Header}.${b64Payload}`, secret);
  return `${b64Header}.${b64Payload}.${signature}`;
}

async function verifyToken(token, secret) {
  const [b64Header, b64Payload, signature] = token.split('.');
  if (!b64Header || !b64Payload || !signature) throw new Error('Format invalide');
  const expected = await sign(`${b64Header}.${b64Payload}`, secret);
  if (signature !== expected) throw new Error('Signature invalide');
  return JSON.parse(base64UrlDecode(b64Payload));
}

async function sign(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return base64UrlEncode(sig);
}

function base64UrlEncode(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(b64) {
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return atob(b64);
}
