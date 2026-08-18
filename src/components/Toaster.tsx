import { useEffect } from 'react';
import { useAppState, clearToast } from '../state/store';

export default function Toaster() {
  const { toast } = useAppState();

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(clearToast, toast.kind === 'error' ? 8000 : 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} onClick={clearToast} role="status">
      {toast.message}
    </div>
  );
}
