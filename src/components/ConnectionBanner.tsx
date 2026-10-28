import { useSyncExternalStore } from 'react';
import { WifiOff } from 'lucide-react';
import { getLastError, onError } from '../api/client';

/** Aviso fixo quando o servidor não responde ou uma ação falha. */
export function ConnectionBanner() {
  const error = useSyncExternalStore(onError, getLastError);
  if (!error) return null;
  return (
    <div className="conn-banner" role="alert">
      <WifiOff size={15} />
      {error}
    </div>
  );
}
