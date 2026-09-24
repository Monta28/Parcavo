import { NextResponse, type NextRequest } from 'next/server';

/**
 * Contrôle de navigation optimiste (CDC 16.1) : redirige vers /login sans cookie de session.
 * Ce contrôle ne remplace jamais l'autorisation de l'API, qui reste seule décisionnaire.
 */
const PUBLIC_PATHS = ['/login', '/mot-de-passe-oublie', '/reinitialisation'];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has('pa_session');
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!hasSession && !isPublic) {
    const url = new URL('/login', request.url);
    if (pathname !== '/') url.searchParams.set('suite', pathname);
    return NextResponse.redirect(url);
  }
  if (hasSession && pathname === '/login') {
    return NextResponse.redirect(new URL('/tableau-de-bord', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/).*)'],
};
