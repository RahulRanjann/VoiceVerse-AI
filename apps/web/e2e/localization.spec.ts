import { expect, test, type Page, type Route } from '@playwright/test';

const jobId = '01900000-0000-7000-8000-000000000601';
const projectId = '01900000-0000-7000-8000-000000000602';
const trackId = '01900000-0000-7000-8000-000000000603';
const sceneId = '01900000-0000-7000-8000-000000000604';
const dialogueId = '01900000-0000-7000-8000-000000000605';
const generationId = '01900000-0000-7000-8000-000000000606';

test('scene translation supports launch, CAS edits, review, glossary, history, and generation', async ({
  page,
}) => {
  const mobileViewport = process.env.PLAYWRIGHT_QA_VIEWPORT === 'mobile';
  if (mobileViewport) await page.setViewportSize({ height: 844, width: 390 });
  const browserErrors = captureBrowserErrors(page);
  const state = localizationState();
  let trackOpened = false;
  let generationPolls = 0;
  const generationKeys: string[] = [];
  let generationRequests = 0;

  await mockAuth(page);
  await mockAnalysis(page);
  await page.route(`**/v1/projects/${projectId}/localization-tracks`, async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({
        speechAnalysisJobId: jobId,
        targetLanguageId: 'language-hi',
      });
      trackOpened = true;
      return json(route, state.track);
    }
    return json(route, { data: trackOpened ? [state.track] : [] });
  });
  await page.route(
    `**/v1/projects/${projectId}/localization-tracks/${trackId}/scenes?**`,
    (route) => json(route, scenePage(state)),
  );
  await page.route(
    `**/v1/projects/${projectId}/localization-tracks/${trackId}/scenes/${sceneId}`,
    async (route) => {
      const body = route.request().postDataJSON() as {
        expectedRevision: number;
        title: string | null;
        narrative: string | null;
        culturalNotes: string | null;
      };
      expect(body.expectedRevision).toBe(state.scene.selectionRevision);
      state.scene.selectionRevision += 1;
      state.scene.revision = {
        ...state.scene.revision,
        id: 'scene-revision-2',
        revisionNumber: 2,
        title: body.title,
        narrative: body.narrative,
        culturalNotes: body.culturalNotes,
      };
      return json(route, {
        ...state.scene.revision,
        sceneId,
        selectionRevision: state.scene.selectionRevision,
      });
    },
  );
  await page.route(
    `**/v1/projects/${projectId}/localization-tracks/${trackId}/dialogues/${dialogueId}/translation`,
    async (route) => {
      const body = route.request().postDataJSON() as {
        expectedRevision: number;
        targetText: string;
      };
      const current = state.scene.dialogues[0]!.translation;
      expect(body.expectedRevision).toBe(current?.selectionRevision ?? 0);
      state.scene.dialogues[0]!.translation = translation(
        body.targetText,
        (current?.selectionRevision ?? 0) + 1,
        'DRAFT',
        (current?.revisionNumber ?? 0) + 1,
        state.scene.dialogues[0]!.source.revisionId,
      );
      return json(route, translationResponse(state.scene.dialogues[0]!.translation!));
    },
  );
  await page.route(
    `**/v1/projects/${projectId}/localization-tracks/${trackId}/dialogues/${dialogueId}/translation/state`,
    async (route) => {
      const body = route.request().postDataJSON() as {
        expectedRevision: number;
        state: 'IN_REVIEW';
      };
      const current = state.scene.dialogues[0]!.translation!;
      expect(body).toEqual({
        expectedRevision: current.selectionRevision,
        state: 'IN_REVIEW',
      });
      state.scene.dialogues[0]!.translation = {
        ...current,
        editorState: body.state,
        selectionRevision: current.selectionRevision + 1,
      };
      return json(route, translationResponse(state.scene.dialogues[0]!.translation!));
    },
  );
  await page.route(
    `**/v1/projects/${projectId}/localization-tracks/${trackId}/dialogues/${dialogueId}/source/revisions?**`,
    (route) =>
      json(route, {
        data: [
          sourceRevision('source-revision-2', 2, 'The rain has stopped.'),
          sourceRevision('source-revision-1', 1, 'The rain stopped.'),
        ],
        nextCursor: null,
        selectedRevisionId: state.scene.dialogues[0]!.source.revisionId,
        selectionRevision: state.scene.dialogues[0]!.source.selectionRevision,
      }),
  );
  await page.route(
    `**/v1/projects/${projectId}/localization-tracks/${trackId}/dialogues/${dialogueId}/source/selection`,
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        expectedRevision: 2,
        revisionId: 'source-revision-1',
      });
      state.scene.dialogues[0]!.source = {
        revisionId: 'source-revision-1',
        revisionNumber: 1,
        selectionRevision: 3,
        text: 'The rain stopped.',
      };
      const currentTranslation = state.scene.dialogues[0]!.translation!;
      state.scene.dialogues[0]!.translation = {
        ...currentTranslation,
        editorState: 'DRAFT',
        selectionRevision: currentTranslation.selectionRevision + 1,
      };
      return json(route, {
        ...sourceRevision('source-revision-1', 1, 'The rain stopped.'),
        selectionRevision: 3,
      });
    },
  );
  await page.route(
    `**/v1/projects/${projectId}/localization-tracks/${trackId}/glossary`,
    async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        expect(body).toMatchObject({ sourceTerm: 'Monsoon', targetTerm: 'मानसून' });
        state.glossary = [glossaryEntry()];
        return json(route, state.glossary[0]);
      }
      return json(route, { data: state.glossary, trackId });
    },
  );
  await page.route(
    `**/v1/projects/${projectId}/localization-tracks/${trackId}/generations`,
    async (route) => {
      generationRequests += 1;
      generationKeys.push(route.request().headers()['idempotency-key'] ?? '');
      expect(route.request().postDataJSON()).toEqual({ sceneId });
      if (generationRequests === 1) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{',
        });
      }
      return json(route, generation('QUEUED'));
    },
  );
  await page.route(
    `**/v1/projects/${projectId}/localization-tracks/${trackId}/generations/${generationId}`,
    (route) => {
      generationPolls += 1;
      if (generationPolls > 1) {
        state.scene.dialogues[0]!.translation = translation(
          'बारिश अब थम गई है।',
          5,
          'DRAFT',
          3,
          'source-revision-1',
        );
        return json(route, generation('SUCCEEDED'));
      }
      return json(route, generation('RUNNING'));
    },
  );

  await page.goto(`/jobs/${jobId}`);
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}$`));
  await expect(page).toHaveTitle('VoiceVerse AI');
  await expect(page.getByRole('heading', { name: 'Monsoon Letters' })).toBeVisible();
  await expect(page.getByText('Scene-aware translation')).toBeVisible();

  await page.getByRole('button', { name: 'Open language editor' }).click();
  await expect(page.getByText('Hindi translation')).toBeVisible();
  await expect(page.getByText('Asha', { exact: true }).last()).toBeVisible();

  const target = page.getByRole('textbox', { name: /Hindi target for Asha/ });
  await target.fill('बारिश रुक गई।');
  await page.getByRole('button', { name: 'Save target' }).click();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  const sendToReview = page.getByRole('button', { name: 'Send to review' });
  await target.fill('बारिश अभी रुक गई।');
  await expect(sendToReview).toBeDisabled();
  await expect(
    page.getByText('Save or discard the target edit before changing review status.'),
  ).toBeVisible();
  await target.fill('बारिश रुक गई।');
  const source = page.getByRole('textbox', { name: /English source for Asha/ });
  await source.fill('The rain has stopped. Unsaved');
  await expect(sendToReview).toBeDisabled();
  await expect(
    page.getByText('Save or discard the source edit before changing review status.'),
  ).toBeVisible();
  await source.fill('The rain has stopped.');
  await expect(sendToReview).toBeEnabled();
  await sendToReview.click();
  await expect(page.getByText('In review', { exact: true })).toBeVisible();

  await page.getByLabel('Scene title').fill('Station arrival');
  await page.getByRole('button', { name: 'Save scene context' }).click();
  await expect(page.getByText('Station arrival', { exact: true }).last()).toBeVisible();

  await page.getByRole('button', { name: 'Glossary' }).click();
  const glossary = page.getByRole('dialog', { name: 'Track glossary' });
  await glossary.getByRole('button', { name: 'Add term' }).click();
  await glossary.getByLabel('Source term').fill('Monsoon');
  await glossary.getByLabel('Target term').fill('मानसून');
  await glossary.getByRole('button', { name: 'Save term' }).click();
  await expect(glossary.getByText('Monsoon', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  const dialogueRow = page.locator('article').filter({ hasText: 'Asha' }).last();
  await dialogueRow.getByRole('button', { name: 'History' }).first().click();
  const history = page.getByRole('dialog', { name: 'Source dialogue history' });
  await history.getByRole('button', { name: 'Restore' }).click();
  await expect(source).toHaveValue('The rain stopped.');
  await page.keyboard.press('Escape');

  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await expect(page.getByText('Source changed since translation')).toBeVisible();
  await expect(sendToReview).toBeDisabled();
  await expect(
    page.getByText('Save or regenerate the target against the latest source before review.'),
  ).toBeVisible();
  await target.fill('बारिश फिर थम गई।');
  await page.getByRole('button', { name: 'Save target' }).click();
  await expect(page.getByText('Source changed since translation')).toHaveCount(0);

  await page.getByRole('button', { name: 'Generate scene' }).click();
  await expect(page.getByText('Generation request failed')).toBeVisible();
  await page.getByRole('button', { name: 'Retry request' }).click();
  await expect(page.getByText('Generation complete')).toBeVisible({ timeout: 8_000 });
  await expect(target).toHaveValue('बारिश अब थम गई है।');
  expect(generationKeys).toHaveLength(2);
  expect(generationKeys[0]).toMatch(/^web-[0-9a-f-]{36}$/);
  expect(generationKeys[1]).toBe(generationKeys[0]);
  expect(browserErrors).toEqual([]);

  const screenshotDirectory = process.env.PLAYWRIGHT_QA_SCREENSHOT_DIR;
  if (screenshotDirectory) {
    await page.screenshot({
      fullPage: false,
      path: `${screenshotDirectory}/m6-localization-${mobileViewport ? 'mobile' : 'desktop'}.png`,
    });
  }
});

function localizationState() {
  const track = {
    id: trackId,
    projectId,
    workspaceId: '01900000-0000-7000-8000-000000000607',
    speechAnalysisId: '01900000-0000-7000-8000-000000000608',
    createdAt: '2026-07-17T08:00:00.000Z',
    generationEnabled: true,
    sourceLanguage: { id: 'language-en', bcp47Tag: 'en', englishName: 'English' },
    targetLanguage: { id: 'language-hi', bcp47Tag: 'hi', englishName: 'Hindi' },
  };
  const scene = {
    id: sceneId,
    ordinal: 1,
    selectionRevision: 1,
    revision: {
      id: 'scene-revision-1',
      revisionNumber: 1,
      title: null as string | null,
      narrative: null as string | null,
      culturalNotes: null as string | null,
      startMs: 4_250,
      endMs: 7_500,
    },
    dialogues: [
      {
        id: dialogueId,
        ordinal: 1,
        startMs: 4_250,
        endMs: 7_500,
        character: { id: 'character-asha', name: 'Asha' },
        source: {
          revisionId: 'source-revision-2',
          revisionNumber: 2,
          selectionRevision: 2,
          text: 'The rain has stopped.',
        },
        translation: null as ReturnType<typeof translation> | null,
      },
    ],
  };
  return { glossary: [] as ReturnType<typeof glossaryEntry>[], scene, track };
}

function scenePage(state: ReturnType<typeof localizationState>) {
  return { data: [state.scene], nextCursor: null, total: 1, track: state.track };
}

function translation(
  text: string,
  selectionRevision: number,
  editorState: 'DRAFT' | 'IN_REVIEW',
  revisionNumber = selectionRevision,
  sourceRevisionId = 'source-revision-2',
) {
  return {
    translationId: 'translation-1',
    revisionId: `translation-revision-${revisionNumber}`,
    revisionNumber,
    selectionRevision,
    sourceRevisionId,
    editorState,
    text,
  };
}

function translationResponse(value: ReturnType<typeof translation>) {
  return {
    dialogueId,
    editorState: value.editorState,
    generationId: null,
    id: value.revisionId,
    revisionNumber: value.revisionNumber,
    selectionRevision: value.selectionRevision,
    sourceRevisionId: value.sourceRevisionId,
    targetText: value.text,
    translationId: value.translationId,
  };
}

function sourceRevision(id: string, revisionNumber: number, sourceText: string) {
  return {
    id,
    dialogueId,
    revisionNumber,
    sourceText,
    createdAt: `2026-07-17T08:0${revisionNumber}:00.000Z`,
    createdByUserId: 'user-asha',
  };
}

function glossaryEntry() {
  return {
    id: 'glossary-revision-1',
    entryId: 'glossary-entry-1',
    revisionNumber: 1,
    selectionRevision: 1,
    sourceTerm: 'Monsoon',
    targetTerm: 'मानसून',
    notes: null,
    caseSensitive: false,
    doNotTranslate: false,
  };
}

function generation(status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED') {
  const completed = status === 'SUCCEEDED' ? '2026-07-17T08:05:00.000Z' : null;
  return {
    id: generationId,
    trackId,
    sceneId,
    status,
    attemptCount: status === 'QUEUED' ? 0 : 1,
    maxAttempts: 3,
    inputRevisionHash: 'public-hash',
    model: {
      provider: 'configured-provider',
      modelId: 'translation-model',
      modelRevision: 'v1',
      runtimeVersion: '1.0.0',
    },
    promptVersion: 'scene-translation-v1',
    errorCode: null,
    queuedAt: '2026-07-17T08:04:00.000Z',
    startedAt: status === 'QUEUED' ? null : '2026-07-17T08:04:01.000Z',
    completedAt: completed,
    createdAt: '2026-07-17T08:04:00.000Z',
    updatedAt: completed ?? '2026-07-17T08:04:01.000Z',
  };
}

async function mockAnalysis(page: Page) {
  const job = {
    id: jobId,
    kind: 'SPEECH_ANALYSIS',
    status: 'SUCCEEDED',
    pipelineVersion: 'speech-analysis-v1',
    progressBasisPoints: 10_000,
    revision: 4,
    failureCode: null,
    failure: null,
    startedAt: '2026-07-17T07:55:00.000Z',
    completedAt: '2026-07-17T08:00:00.000Z',
    createdAt: '2026-07-17T07:54:00.000Z',
    updatedAt: '2026-07-17T08:00:00.000Z',
    projectId,
    project: {
      id: projectId,
      name: 'Monsoon Letters',
      sourceLanguage: {
        id: 'language-en',
        bcp47Tag: 'en',
        englishName: 'English',
        nativeName: 'English',
      },
      targetLanguages: [
        {
          id: 'language-hi',
          bcp47Tag: 'hi',
          englishName: 'Hindi',
          nativeName: 'हिन्दी',
        },
      ],
    },
    sourceVideo: { id: 'video-1', ingestStatus: 'UPLOADED', securityStatus: 'CLEAN' },
    media: null,
    resultSummary: {
      transcript: { availability: 'AVAILABLE', segmentCount: 1, transcribedDurationMs: 3_250 },
      characters: { availability: 'AVAILABLE', count: 1 },
    },
    stages: [],
  };
  await page.route(`**/v1/jobs/${jobId}`, (route) => json(route, job));
  await page.route(`**/v1/jobs/${jobId}/characters?**`, (route) =>
    json(route, {
      availability: 'AVAILABLE',
      analysisId: 'analysis-1',
      jobRevision: 4,
      data: [],
      totalCount: 0,
      nextCursor: null,
    }),
  );
  await page.route(`**/v1/jobs/${jobId}/dialogue-segments?**`, (route) =>
    json(route, {
      availability: 'AVAILABLE',
      analysisId: 'analysis-1',
      jobRevision: 4,
      data: [],
      totalCount: 0,
      nextCursor: null,
    }),
  );
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
          refresh_token: 'localization-e2e-refresh-token',
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
    json(route, {
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
  );
}

function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
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
