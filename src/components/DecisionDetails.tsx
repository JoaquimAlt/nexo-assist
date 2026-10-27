import { ChevronRight } from 'lucide-react';
import type { Tone } from '../data/labels';
import type { Decision } from '../data/types';

export function confidenceLevel(c: number): { label: string; tone: Tone } {
  if (c >= 0.85) return { label: 'alta', tone: 'green' };
  if (c >= 0.6) return { label: 'média', tone: 'amber' };
  return { label: 'baixa', tone: 'red' };
}

/** Painel recolhível com o que o assistente entendeu, o que fez, com que segurança e por quê. */
export function DecisionDetails({ decision }: { decision: Decision }) {
  const pct = Math.round(decision.confidence * 100);
  const level = confidenceLevel(decision.confidence);

  return (
    <details className="decision">
      <summary>
        <ChevronRight size={13} className="decision-chevron" />
        Como decidi
        <span className={`decision-conf tone-${level.tone}`}>confiança {level.label} · {pct}%</span>
      </summary>
      <div className="decision-body">
        <dl className="decision-grid">
          <dt>Entrada</dt>
          <dd>{decision.trigger}</dd>
          <dt>Intenção</dt>
          <dd>{decision.intent}</dd>
          {decision.understood.length > 0 && (
            <>
              <dt>Entendeu</dt>
              <dd>
                <ul className="decision-facts">
                  {decision.understood.map((f) => (
                    <li key={f.label}>
                      <span className="muted">{f.label}:</span> {f.value}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          <dt>Ação</dt>
          <dd>{decision.action}</dd>
          <dt>Confiança</dt>
          <dd className="decision-meter-row">
            <span className="decision-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Confiança">
              <span className={`decision-meter-fill fill-${level.tone}`} style={{ width: `${pct}%` }} />
            </span>
            {pct}% · {level.label}
          </dd>
        </dl>
        {decision.reasons.length > 0 && (
          <>
            <p className="decision-why">Por quê</p>
            <ol className="decision-reasons">
              {decision.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ol>
          </>
        )}
      </div>
    </details>
  );
}
