import { expect, test, type Page } from '@playwright/test';

const languages = [
  { id: 'language-en', bcp47Tag: 'en', englishName: 'English', nativeName: 'English' },
  { id: 'language-hi', bcp47Tag: 'hi', englishName: 'Hindi', nativeName: 'हिन्दी' },
  { id: 'language-ta', bcp47Tag: 'ta', englishName: 'Tamil', nativeName: 'தமிழ்' },
  { id: 'language-es', bcp47Tag: 'es', englishName: 'Spanish', nativeName: 'Español' },
];

const projects = [
  project(
    'project-monsoon',
    'Monsoon Letters',
    'READY',
    languages[0],
    [languages[1], languages[2]],
    {
      ingestStatus: 'UPLOADED',
      securityStatus: 'CLEAN',
    },
    workflowJob('SUCCEEDED', 10_000),
  ),
  project(
    'project-neon',
    'Neon Harbor',
    'PROCESSING',
    languages[2],
    [languages[3]],
    {
      ingestStatus: 'UPLOADED',
      securityStatus: 'CLEAN',
    },
    workflowJob('RUNNING', 4_200),
  ),
  project(
    'project-queued',
    'Queued Cut',
    'PROCESSING',
    languages[0],
    [languages[3]],
    {
      ingestStatus: 'UPLOADED',
      securityStatus: 'CLEAN',
    },
    workflowJob('QUEUED', 0),
  ),
  project(
    'project-failed',
    'Broken Reel',
    'FAILED',
    languages[0],
    [languages[1]],
    {
      ingestStatus: 'UPLOADED',
      securityStatus: 'CLEAN',
    },
    workflowJob('FAILED', 3_700),
  ),
  project('project-paper', 'Paper Planets', 'INGESTING', languages[0], [languages[1]], {
    ingestStatus: 'UPLOADED',
    securityStatus: 'SCANNING',
  }),
];

test('authenticated studio supports search, upload entry, and mobile navigation', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await mockAuthenticatedApi(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Your dubbing studio' })).toBeVisible();
  const table = page.getByRole('table');
  await expect(table.getByText('Monsoon Letters', { exact: true })).toBeVisible();
  await expect(table.getByText('Neon Harbor', { exact: true })).toBeVisible();
  await expect(table.getByText('Queued Cut', { exact: true })).toBeVisible();
  await expect(table.getByText('Broken Reel', { exact: true })).toBeVisible();
  await expect(table.getByText('Paper Planets', { exact: true })).toBeVisible();
  await expect(table.getByText('Media prepared', { exact: true })).toBeVisible();
  await expect(table.getByText('Preparing media', { exact: true }).first()).toBeVisible();
  await expect(table.getByText('Waiting to prepare', { exact: true })).toBeVisible();
  await expect(table.getByText('Preparation failed', { exact: true })).toBeVisible();
  await expect(table.getByRole('progressbar', { name: 'Preparing media: 42%' })).toBeVisible();
  await expect(table.getByRole('link', { name: 'Monsoon Letters' })).toHaveAttribute(
    'href',
    '/jobs/job-succeeded',
  );

  await page.keyboard.press('Control+K');
  const search = page.getByRole('textbox', { name: 'Search projects' });
  await expect(search).toBeFocused();
  await search.fill('Neon');
  await expect(table.getByText('Neon Harbor', { exact: true })).toBeVisible();
  await expect(table.getByText('Monsoon Letters', { exact: true })).toHaveCount(0);
  await search.fill('');

  await page.getByRole('button', { name: 'Upload movie' }).first().click();
  const uploadDialog = page.getByRole('dialog');
  await expect(uploadDialog.getByRole('heading', { name: 'Upload movie' })).toBeVisible();
  await expect(
    uploadDialog.getByText('Files stay quarantined until malware scanning is complete.'),
  ).toBeVisible();
  await uploadDialog.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: /Aurora Pictures/ }).click();
  await expect(page.getByText('Active workspace')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Asha Rao/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(pageErrors).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const sheet = page.locator('[data-slot="sheet-content"]');
  await expect(sheet.getByText('VoiceVerse', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape');
  const runningProjectCard = page.locator('article').filter({ hasText: 'Neon Harbor' });
  await expect(
    runningProjectCard.getByText('Preparing media', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    runningProjectCard.getByRole('progressbar', { name: 'Preparing media: 42%' }),
  ).toBeVisible();
});

test('anonymous visitors are routed to sign in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
});

test('a control-plane outage does not discard the browser session', async ({ page }) => {
  await mockAuthenticatedApi(page, 503);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'VoiceVerse is temporarily unavailable' }),
  ).toBeVisible();
  await expect(page.getByText('Your session is still safe.')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('an unlinked identity receives an account-review state instead of a login loop', async ({
  page,
}) => {
  await mockAuthenticatedApi(page, 403);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Account access needs review' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

async function mockAuthenticatedApi(page: Page, principalStatus = 200) {
  const accessToken = fakeAccessToken();
  const projectReference = new URL(
    process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321',
  ).hostname.split('.')[0];
  await page.context().addCookies([
    {
      domain: '127.0.0.1',
      name: `sb-${projectReference}-auth-token`,
      path: '/',
      sameSite: 'Lax',
      value: `base64-${Buffer.from(
        JSON.stringify({
          access_token: accessToken,
          expires_at: 4_102_444_800,
          expires_in: 3_600,
          refresh_token: 'browser-test-refresh-token',
          token_type: 'bearer',
          user: {
            app_metadata: { provider: 'google' },
            aud: 'authenticated',
            email: 'asha@voiceverse.test',
            id: '01900000-0000-7000-8000-000000000031',
            role: 'authenticated',
            user_metadata: { full_name: 'Asha Rao' },
          },
        }),
      ).toString('base64url')}`,
    },
  ]);
  await page.route('**/v1/auth/me', (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${accessToken}`);
    if (principalStatus !== 200) {
      return route.fulfill({
        status: principalStatus,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Control plane unavailable.' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 'user-asha',
          email: 'asha@voiceverse.test',
          displayName: 'Asha Rao',
          avatarUrl: null,
        },
        organization: {
          id: 'organization-aurora',
          displayName: 'Aurora Pictures',
          slug: 'aurora-pictures',
          role: 'OWNER',
        },
      }),
    });
  });
  await page.route('**/v1/languages', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(languages),
    }),
  );
  await page.route('**/v1/projects?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: projects, nextCursor: null }),
    }),
  );
}

function fakeAccessToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    aud: 'authenticated',
    exp: 4_102_444_800,
    role: 'authenticated',
    sub: '01900000-0000-7000-8000-000000000031',
  })}.e2e-signature`;
}

function project(
  id: string,
  name: string,
  status: 'READY' | 'PROCESSING' | 'INGESTING' | 'FAILED',
  sourceLanguage: (typeof languages)[number],
  targetLanguages: (typeof languages)[number][],
  latestVideo: { ingestStatus: 'UPLOADED'; securityStatus: 'CLEAN' | 'SCANNING' },
  latestJob: ReturnType<typeof workflowJob> | null = null,
) {
  return {
    id,
    name,
    status,
    sourceLanguage,
    targetLanguages,
    latestJob,
    latestVideo: { id: `${id}-video`, ...latestVideo },
    createdAt: '2026-07-16T08:00:00.000Z',
    updatedAt: '2026-07-16T09:00:00.000Z',
  };
}

function workflowJob(
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED',
  progressBasisPoints: number,
) {
  return {
    id: `job-${status.toLowerCase()}`,
    kind: 'SOURCE_PREPARATION',
    status,
    pipelineVersion: 'source-preparation-v1',
    progressBasisPoints,
    revision: 2,
    failureCode: status === 'FAILED' ? 'MEDIA_PREPARATION_FAILED' : null,
    startedAt: status === 'QUEUED' ? null : '2026-07-16T08:30:00.000Z',
    completedAt: status === 'SUCCEEDED' || status === 'FAILED' ? '2026-07-16T09:00:00.000Z' : null,
    updatedAt: '2026-07-16T09:00:00.000Z',
  } as const;
}
