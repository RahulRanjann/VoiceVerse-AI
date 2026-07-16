import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';

import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'VoiceVerse AI',
  description:
    "Dub any video into any language while preserving every character's unique voice, emotion, and identity.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} dark`} suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
