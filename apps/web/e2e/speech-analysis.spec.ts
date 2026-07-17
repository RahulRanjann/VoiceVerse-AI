import { expect, test, type Page } from '@playwright/test';

const jobId = '01900000-0000-7000-8000-000000000051';
const sourceLanguage = {
  id: 'language-en',
  bcp47Tag: 'en',
  englishName: 'English',
  nativeName: 'English',
};
const targetLanguage = {
  id: 'language-hi',
  bcp47Tag: 'hi',
  englishName: 'Hindi',
  nativeName: 'हिन्दी',
};

test('speech analysis overview preserves progress, paginates dialogue, and hides internals', async ({
  page,
}) => {
  const browserErrors = captureBrowserErrors(page);
  const conditionalRequests: Array<string | undefined> = [];
  await mockAuth(page);
  await mockSpeechAnalysis(page, {
    onJobRequest: (header) => conditionalRequests.push(header),
  });

  await page.goto(`/jobs/${jobId}`);

  await expect(page.getByRole('heading', { name: 'Monsoon Letters' })).toBeVisible();
  await expect(page.getByText('English → Hindi')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Overall progress' })).toHaveAttribute(
    'aria-valuenow',
    '67',
  );
  await expect(page.getByRole('heading', { name: 'Analysis stages' })).toBeVisible();
  await expect(page.getByText('Separate vocals')).toBeVisible();
  await expect(page.getByText('Waiting on earlier step')).toBeVisible();
  await expect(page.getByText('Additional analysis')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Characters' }).getByText('Asha', { exact: true }),
  ).toBeVisible();
  const dialogueTable = page.getByRole('table', {
    name: 'Detected source-language dialogue in timeline order.',
  });
  await expect(dialogueTable.getByRole('cell', { name: '00:00:04.250' })).toBeVisible();
  await expect(dialogueTable.getByText('The rain has finally stopped.')).toBeVisible();

  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(dialogueTable.getByText('We should leave before sunset.')).toBeVisible();
  await expect(page.getByText('Showing 3 of 3 lines')).toBeVisible();

  await expect.poll(() => conditionalRequests.length, { timeout: 7_000 }).toBeGreaterThan(1);
  expect(conditionalRequests).toContain(`W/"job-${jobId}-7"`);
  await expect(page.getByText('provider-pyannote-v9')).toHaveCount(0);
  await expect(page.getByText('speaker-cluster-private')).toHaveCount(0);
  await expect(page.getByText('GPU_WORKER_TRACE_998')).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test('failed analysis is safe and usable on a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const browserErrors = captureBrowserErrors(page);
  await mockAuth(page);
  await mockSpeechAnalysis(page, { failed: true });

  await page.goto(`/jobs/${jobId}`);

  await expect(page.getByRole('heading', { name: 'Monsoon Letters' })).toBeVisible();
  await expect(page.getByRole('alert').getByText('Analysis needs attention')).toBeVisible();
  await expect(
    page.getByText('Character results are not available for this analysis.'),
  ).toBeVisible();
  await expect(page.getByText('A transcript is not available for this analysis.')).toBeVisible();
  await expect(page.getByText('GPU_WORKER_TRACE_998')).toHaveCount(0);
  await expect(page.getByText('provider-pyannote-v9')).toHaveCount(0);

  await page.getByRole('button', { name: 'Open navigation' }).click();
  const navigation = page.getByRole('dialog', { name: 'VoiceVerse' });
  await expect(navigation.getByRole('heading', { name: 'VoiceVerse' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Sign out' })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function mockAuth(page: Page) {
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
          refresh_token: 'speech-e2e-refresh-token',
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
  await page.route('**/v1/auth/me', (route) =>
    route.fulfill({
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
    }),
  );
}

async function mockSpeechAnalysis(
  page: Page,
  options: { failed?: boolean; onJobRequest?(etag: string | undefined): void } = {},
) {
  const job = speechJob(options.failed ?? false);
  await page.route(`**/v1/jobs/${jobId}`, (route) => {
    const etag = route.request().headers()['if-none-match'];
    options.onJobRequest?.(etag);
    if (etag === `W/"job-${jobId}-${job.revision}"`) {
      return route.fulfill({ status: 304, headers: { etag } });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { etag: `W/"job-${jobId}-${job.revision}"` },
      body: JSON.stringify(job),
    });
  });
  await page.route(`**/v1/jobs/${jobId}/characters?**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        options.failed
          ? resultPage('UNAVAILABLE', [], 0)
          : resultPage(
              'AVAILABLE',
              [
                {
                  id: 'character-asha',
                  displayName: 'Asha',
                  firstAppearanceMs: 4_250,
                  segmentCount: 2,
                  speakingDurationMs: 9_500,
                  confidenceBasisPoints: 9_400,
                },
                {
                  id: 'character-dev',
                  displayName: 'Dev',
                  firstAppearanceMs: 9_700,
                  segmentCount: 1,
                  speakingDurationMs: 3_200,
                  confidenceBasisPoints: 8_900,
                },
              ],
              2,
            ),
      ),
    }),
  );
  await page.route(`**/v1/jobs/${jobId}/dialogue-segments?**`, (route) => {
    if (options.failed) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(resultPage('UNAVAILABLE', [], 0)),
      });
    }
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    const firstPage = cursor === null;
    const segments = firstPage
      ? [
          dialogue('segment-1', 1, 4_250, 'The rain has finally stopped.', 'Asha'),
          dialogue('segment-2', 2, 9_700, 'For now.', 'Dev'),
        ]
      : [dialogue('segment-3', 3, 14_400, 'We should leave before sunset.', 'Asha')];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...resultPage('AVAILABLE', segments, 3),
        nextCursor: firstPage ? 'cursor-two' : null,
      }),
    });
  });
}

function speechJob(failed: boolean) {
  const stageStatus = failed ? 'FAILED' : 'RUNNING';
  return {
    id: jobId,
    kind: 'SPEECH_ANALYSIS',
    status: failed ? 'FAILED' : 'RUNNING',
    pipelineVersion: 'speech-analysis-v1',
    progressBasisPoints: failed ? 4_500 : 6_700,
    revision: 7,
    failureCode: failed ? 'GPU_WORKER_TRACE_998' : null,
    failure: failed
      ? { category: 'INTERNAL', code: 'GPU_WORKER_TRACE_998', retryable: true }
      : null,
    startedAt: '2026-07-17T08:00:00.000Z',
    completedAt: failed ? '2026-07-17T08:05:00.000Z' : null,
    createdAt: '2026-07-17T07:59:00.000Z',
    updatedAt: '2026-07-17T08:05:00.000Z',
    projectId: '01900000-0000-7000-8000-000000000052',
    project: {
      id: '01900000-0000-7000-8000-000000000052',
      name: 'Monsoon Letters',
      sourceLanguage,
      targetLanguages: [targetLanguage],
    },
    sourceVideo: {
      id: '01900000-0000-7000-8000-000000000053',
      ingestStatus: 'UPLOADED',
      securityStatus: 'CLEAN',
    },
    media: null,
    resultSummary: {
      transcript: {
        availability: failed ? 'UNAVAILABLE' : 'AVAILABLE',
        segmentCount: failed ? 0 : 3,
        transcribedDurationMs: failed ? 0 : 12_700,
      },
      characters: {
        availability: failed ? 'UNAVAILABLE' : 'AVAILABLE',
        count: failed ? 0 : 2,
      },
    },
    stages: [
      stage('stage-vocals', 'audio.vocals.separate', 'SUCCEEDED', 10_000, 0),
      stage('stage-transcript', 'speech.transcribe', stageStatus, failed ? 4_500 : 8_000, 1),
      stage(
        'stage-diarize',
        'speech.diarize',
        failed ? 'BLOCKED' : 'SUCCEEDED',
        failed ? 0 : 10_000,
        2,
      ),
      stage(
        'stage-character',
        'characters.resolve',
        failed ? 'BLOCKED' : 'RUNNING',
        failed ? 0 : 5_000,
        3,
      ),
      stage('stage-private', 'provider.private.step', 'BLOCKED', 0, 4),
    ],
  };
}

function stage(
  id: string,
  key: string,
  status: string,
  progressBasisPoints: number,
  ordinal: number,
) {
  return {
    id,
    key,
    kind: 'SPEECH_RECOGNITION',
    status,
    progressBasisPoints,
    attemptCount: 1,
    ordinal,
    startedAt: null,
    completedAt: null,
    failure: null,
    currentAttempt: {
      id: `${id}-attempt`,
      attemptNumber: 1,
      status: status === 'FAILED' ? 'FAILED' : 'RUNNING',
      progressBasisPoints,
      errorCode: 'GPU_WORKER_TRACE_998',
      provider: 'provider-pyannote-v9',
      startedAt: null,
      completedAt: null,
    },
  };
}

function resultPage(availability: string, data: object[], totalCount: number) {
  return {
    availability,
    analysisId: availability === 'AVAILABLE' ? 'analysis-1' : null,
    jobRevision: 7,
    data,
    totalCount,
    nextCursor: null,
  };
}

function dialogue(
  id: string,
  sequenceNumber: number,
  startMs: number,
  sourceText: string,
  name: string,
) {
  return {
    id,
    sequenceNumber,
    startMs,
    endMs: startMs + 2_500,
    sourceText,
    sourceLanguageTag: 'en',
    transcriptionConfidenceBasisPoints: 9_300,
    speakerLabel: 'speaker-cluster-private',
    provider: 'provider-pyannote-v9',
    character: {
      id: `character-${name.toLowerCase()}`,
      displayName: name,
      assignmentConfidenceBasisPoints: 9_100,
    },
  };
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
