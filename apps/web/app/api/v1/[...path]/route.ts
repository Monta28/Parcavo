import type { NextRequest } from 'next/server';

/**
 * Relais des appels /api/v1 du navigateur vers l'API NestJS interne (API_INTERNAL_URL, lue à
 * l'exécution). Aucune logique métier : méthode, en-têtes, corps (y compris multipart) et cookies
 * sont transmis tels quels ; l'API reste seule juge des autorisations. En production, le reverse
 * proxy peut aussi router /api directement vers l'API sans passer par ce relais.
 */
export const dynamic = 'force-dynamic';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

function apiOrigin(): string {
  return process.env.API_INTERNAL_URL ?? 'http://localhost:3001';
}

async function relay(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  if (path.some((segment) => segment === '.' || segment === '..' || segment === '')) {
    return Response.json({ code: 'CHEMIN_INVALIDE', message: 'Chemin invalide.' }, { status: 400 });
  }
  const target = new URL(`/api/v1/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`, apiOrigin());
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, redirect: 'manual', cache: 'no-store' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    return Response.json({ code: 'API_INJOIGNABLE', message: 'Service momentanément indisponible : rien n’a été enregistré.' }, { status: 502 });
  }
  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    // fetch décompresse le corps : l'encodage et la longueur d'origine ne s'appliquent plus.
    if (!HOP_BY_HOP.has(k) && k !== 'set-cookie' && k !== 'content-encoding') out.set(key, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export { relay as DELETE, relay as GET, relay as PATCH, relay as POST, relay as PUT };
