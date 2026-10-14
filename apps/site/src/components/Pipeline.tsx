import { Activity, Archive, Bot, Database, Filter, HardDrive, KeyRound, ListChecks, Lock, Server, ShieldCheck, EyeOff, Zap, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import type { SiteMessageKey } from '../i18n/catalog';
import { useT } from '../i18n/I18nProvider';
import { useInView, useReducedMotion } from '../lib/motion';

interface Step {
  name: SiteMessageKey;
  desc: SiteMessageKey;
  icon: LucideIcon;
}

const REQUEST: Step[] = [
  { name: 'pipeline.agent', desc: 'pipeline.agentDesc', icon: Bot },
  { name: 'pipeline.auth', desc: 'pipeline.authDesc', icon: KeyRound },
  { name: 'pipeline.policy', desc: 'pipeline.policyDesc', icon: ShieldCheck },
  { name: 'pipeline.validate', desc: 'pipeline.validateDesc', icon: ListChecks },
  { name: 'pipeline.creds', desc: 'pipeline.credsDesc', icon: Lock },
  { name: 'pipeline.upstream', desc: 'pipeline.upstreamDesc', icon: Server },
];

/** Flow order of the way back; rendered reversed so it reads right-to-left under the request lane. */
const RESPONSE: Step[] = [
  { name: 'pipeline.upstream', desc: 'pipeline.upstreamDesc', icon: Server },
  { name: 'pipeline.redact', desc: 'pipeline.redactDesc', icon: EyeOff },
  { name: 'pipeline.project', desc: 'pipeline.projectDesc', icon: Filter },
  { name: 'pipeline.offload', desc: 'pipeline.offloadDesc', icon: Archive },
  { name: 'pipeline.event', desc: 'pipeline.eventDesc', icon: Activity },
  { name: 'pipeline.agent', desc: 'pipeline.agentDesc', icon: Bot },
];

const STEPS = REQUEST.length + RESPONSE.length;
const LAST = REQUEST.length - 1;

function Lane({ title, steps, reversed, active, packet }: { title: string; steps: Step[]; reversed: boolean; active: number; packet: boolean }) {
  const t = useT();
  const ordered = reversed ? [...steps].reverse() : steps;
  // position of the packet along the lane in DOM order (0 = first node, 1 = last)
  const p = active < 0 ? 0 : reversed ? 1 - active / LAST : active / LAST;
  return (
    <div className="lane">
      <div className={`lane-title mono-label ${reversed ? 'is-reversed' : ''}`}>{title}</div>
      <ol className="lane-track" style={{ '--p': p } as CSSProperties}>
        {ordered.map((s, domIndex) => {
          const flowIndex = reversed ? steps.length - 1 - domIndex : domIndex;
          const state = flowIndex === active ? 'is-active' : flowIndex < active ? 'is-done' : '';
          const Icon = s.icon;
          return (
            <li key={`${s.name}${domIndex}`} className={`node ${state}`}>
              <span className="node-icon">
                <Icon size={18} />
              </span>
              <span className="node-name">{t(s.name)}</span>
              <span className="node-desc">{t(s.desc)}</span>
            </li>
          );
        })}
        <span className={`packet ${packet ? 'is-on' : ''}`} aria-hidden="true" />
      </ol>
    </div>
  );
}

/** Request and response lanes; a packet walks the governed path in a loop while each stage lights up. */
export function Pipeline() {
  const t = useT();
  const reduce = useReducedMotion();
  const [ref, seen] = useInView<HTMLDivElement>(0.25);
  const [tick, setTick] = useState(-1);

  useEffect(() => {
    if (!seen || reduce) return;
    const id = setInterval(() => setTick((n) => (n + 1) % (STEPS + 2)), 720);
    return () => clearInterval(id);
  }, [seen, reduce]);

  // Reduced motion: every stage shown lit, no packet.
  const req = reduce ? LAST + 1 : tick < REQUEST.length ? tick : LAST + 1;
  const res = reduce ? LAST + 1 : tick >= REQUEST.length ? Math.min(tick - REQUEST.length, LAST + 1) : -1;
  return (
    <div className="pipeline" ref={ref}>
      <Lane title={`${t('pipeline.request')} →`} steps={REQUEST} reversed={false} active={req} packet={!reduce && tick >= 0 && tick < REQUEST.length} />
      <Lane title={`← ${t('pipeline.response')}`} steps={RESPONSE} reversed={true} active={res} packet={!reduce && tick >= REQUEST.length && tick < STEPS} />
      <div className="storage">
        <span className="mono-label">{t('pipeline.storage')}</span>
        <div className="storage-item">
          <Database size={16} />
          <b>Postgres</b>
          <span>{t('pipeline.pg')}</span>
        </div>
        <div className="storage-item">
          <Zap size={16} />
          <b>Redis</b>
          <span>{t('pipeline.redis')}</span>
        </div>
        <div className="storage-item">
          <HardDrive size={16} />
          <b>S3 / MinIO</b>
          <span>{t('pipeline.s3')}</span>
        </div>
      </div>
    </div>
  );
}
