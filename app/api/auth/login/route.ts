import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const { password } = await request.json()
    const expectedPassword = process.env.AUTH_PASSWORD

    if (!expectedPassword) {
      console.error('AUTH_PASSWORD not configured')
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
    }

    if (password !== expectedPassword) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
    }

    // Set auth cookie
    const response = NextResponse.json({ success: true })
    response.cookies.set('aac_auth', password, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: '/',
    })

    return response
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}
