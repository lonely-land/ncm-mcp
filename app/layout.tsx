import type { Metadata, Viewport } from 'next'

import { getMessages } from '@/lib/i18n'

import './globals.css'
import { Geist } from 'next/font/google'
import { cn } from '@/lib/utils'

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' })

export async function generateMetadata(): Promise<Metadata> {
  const { messages } = await getMessages()
  return {
    title: messages.meta.title,
    description: messages.meta.description,
  }
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
  width: 'device-width',
  initialScale: 1,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale } = await getMessages()
  return (
    <html lang={locale} className={cn('dark font-sans', geist.variable)}>
      <body className="antialiased">{children}</body>
    </html>
  )
}
