import type { Metadata } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: 'NeteaseCloudMusic MCP',
  description:
    'A stateless Model Context Protocol server for the NetEase Cloud Music API, with a built-in OAuth 2.1 authorization server.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
