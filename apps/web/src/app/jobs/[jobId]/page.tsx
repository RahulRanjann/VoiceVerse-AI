import { AuthGate } from '@/features/auth/auth-gate';
import { SpeechAnalysisOverview } from '@/features/studio/speech-analysis-overview';

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return (
    <AuthGate>
      <SpeechAnalysisOverview jobId={jobId} />
    </AuthGate>
  );
}
