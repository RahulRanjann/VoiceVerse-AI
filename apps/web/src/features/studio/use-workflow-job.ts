'use client';

import { useEffect, useRef } from 'react';
import useSWR from 'swr';

import { useAuth } from '@/features/auth/auth-provider';
import type { WorkflowJob } from '@/features/studio/types';
import { ApiError } from '@/lib/api';
import { getWorkflowJobResult } from './api';
import { isActiveWorkflowJob } from './workflow-presentation';

const ACTIVE_JOB_POLL_INTERVAL_MS = 5_000;

export function useWorkflowJob(jobId: string) {
  const { requestResult } = useAuth();
  const latestJob = useRef<WorkflowJob | undefined>(undefined);

  const swr = useSWR<WorkflowJob, Error>(
    jobId ? ['workflow-job', jobId] : null,
    async () => {
      const current = latestJob.current;
      const result = await getWorkflowJobResult(requestResult, jobId, current?.revision);
      if (result.notModified && current) return current;
      if (!result.data) throw new Error('The workflow response was empty.');

      // Late responses must not move an actively observed job backwards.
      if (current && result.data.revision < current.revision) return current;
      latestJob.current = result.data;
      return result.data;
    },
    {
      dedupingInterval: 1_000,
      keepPreviousData: true,
      refreshInterval: (job) =>
        isActiveWorkflowJob(job ?? null) ? ACTIVE_JOB_POLL_INTERVAL_MS : 0,
      refreshWhenHidden: false,
      revalidateOnFocus: true,
      shouldRetryOnError: true,
      onErrorRetry(error, _key, _config, revalidate, options) {
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return;
        if (options.retryCount >= 5) return;
        setTimeout(
          () => void revalidate(options),
          Math.min(2 ** options.retryCount * 1_000, 15_000),
        );
      },
    },
  );

  useEffect(() => {
    if (swr.data && (!latestJob.current || swr.data.revision >= latestJob.current.revision)) {
      latestJob.current = swr.data;
    }
  }, [swr.data]);

  return swr;
}
