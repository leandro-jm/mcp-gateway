import type { ReactNode } from 'react';
import { Reveal } from '../components/Reveal';

/** Mono section label + uppercase title + lead, shared by every section. */
export function SectionHead({ index, label, title, lead }: { index: string; label: string; title: string; lead?: ReactNode }) {
  return (
    <Reveal className="section-head">
      <div className="section-label mono-label">
        <span className="section-index">{index}</span>
        <span>{label}</span>
      </div>
      <h2 className="section-title">{title}</h2>
      {lead && <p className="section-lead">{lead}</p>}
    </Reveal>
  );
}
