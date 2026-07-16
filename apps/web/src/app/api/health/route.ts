export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(
    {
      service: 'voiceverse-web',
      status: 'ok',
      version: process.env.APP_VERSION ?? 'development',
      timestamp: new Date().toISOString(),
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
