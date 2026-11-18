import type { Metadata, Viewport } from 'next'

import './globals.css'
import { Geist } from 'next/font/google'
import { cn } from '@/lib/utils'

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' })

export const metadata: Metadata = {
  title: 'NeteaseCloudMusic MCP',
  description:
    'A stateless Model Context Protocol server for the NetEase Cloud Music API, with a built-in OAuth 2.1 authorization server.',
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={cn('dark font-sans', geist.variable)}>
      <body className="antialiased">{children}</body>
    </html>
  )
}
