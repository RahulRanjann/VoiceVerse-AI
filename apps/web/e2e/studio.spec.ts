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
  ),
  project('project-neon', 'Neon Harbor', 'PROCESSING', languages[2], [languages[3]], {
    ingestStatus: 'UPLOADED',
    securityStatus: 'CLEAN',
  }),
  project('project-paper', 'Paper Planets', 'INGESTING', languages[0], [languages[1]], {
    ingestStatus: 'UPLOADED',
    securityStatus: 'SCANNING',
  }),
];

test('authenticated studio supports search, upload entry, and mobile navigation', async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Your dubbing studio' })).toBeVisible();
  const table = page.getByRole('table');
  await expect(table.getByText('Monsoon Letters', { exact: true })).toBeVisible();
  await expect(table.getByText('Neon Harbor', { exact: true })).toBeVisible();
  await expect(table.getByText('Paper Planets', { exact: true })).toBeVisible();

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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const sheet = page.locator('[data-slot="sheet-content"]');
  await expect(sheet.getByText('VoiceVerse', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('anonymous visitors are routed to sign in', async ({ page }) => {
  await page.route('**/v1/auth/refresh', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Authentication is required.' }),
    }),
  );

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
});

async function mockAuthenticatedApi(page: Page) {
  await page.route('**/v1/auth/refresh', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: 'browser-test-access-token',
        expiresInSeconds: 300,
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
    }),
  );
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

function project(
  id: string,
  name: string,
  status: 'READY' | 'PROCESSING' | 'INGESTING',
  sourceLanguage: (typeof languages)[number],
  targetLanguages: (typeof languages)[number][],
  latestVideo: { ingestStatus: 'UPLOADED'; securityStatus: 'CLEAN' | 'SCANNING' },
) {
  return {
    id,
    name,
    status,
    sourceLanguage,
    targetLanguages,
    latestVideo: { id: `${id}-video`, ...latestVideo },
    createdAt: '2026-07-16T08:00:00.000Z',
    updatedAt: '2026-07-16T09:00:00.000Z',
  };
}
