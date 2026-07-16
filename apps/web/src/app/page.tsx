import { AuthGate } from '@/features/auth/auth-gate';
import { StudioDashboard } from '@/features/studio/studio-dashboard';

export default function Home() {
  return (
    <AuthGate>
      <StudioDashboard />
    </AuthGate>
  );
}
