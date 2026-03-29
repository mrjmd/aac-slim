import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Routes that don't require authentication
const publicPaths = ['/login', '/api/auth/login']

// Routes that should not be processed by Next.js middleware (existing Vercel functions)
const apiPaths = ['/api/webhooks', '/api/campaign', '/api/oauth', '/api/health']

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Skip middleware for existing API routes (let Vercel handle them)
  if (apiPaths.some(path => pathname.startsWith(path))) {
    return NextResponse.next()
  }

  // Allow public paths
  if (publicPaths.some(path => pathname.startsWith(path))) {
    return NextResponse.next()
  }

  // Check for auth cookie
  const authCookie = request.cookies.get('aac_auth')

  if (!authCookie?.value) {
    // Redirect to login
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  // Validate the auth token
  const expectedToken = process.env.AUTH_PASSWORD
  if (authCookie.value !== expectedToken) {
    // Invalid token, redirect to login
    const loginUrl = new URL('/login', request.url)
    const response = NextResponse.redirect(loginUrl)
    response.cookies.delete('aac_auth')
    return response
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // Match all paths except static files and Next.js internals
    '/((?!_next/static|_next/image|favicon.ico|api/webhooks).*)',
  ],
}
