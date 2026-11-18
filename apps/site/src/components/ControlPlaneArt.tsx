import { useEffect, useRef } from 'react';
import { useT } from '../i18n/I18nProvider';
import { useOnScreen, useReducedMotion } from '../lib/motion';
import { CubeBody } from './CubeArt';

const ROWS = [56, 128, 200, 272];
const HUB_Y = 164;
/** x of: client right edge, hub left, hub right, server left edge. */
const X = { client: 108, hubIn: 166, hubOut: 294, server: 352 };
const BEND = 34;
const CYCLE = 9;

const toHub = (y: number) => `M${X.client},${y} C${X.client + BEND},${y} ${X.hubIn - BEND},${HUB_Y} ${X.hubIn},${HUB_Y}`;
const toServer = (y: number) => `M${X.hubOut},${HUB_Y} C${X.hubOut + BEND},${HUB_Y} ${X.server - BEND},${y} ${X.server},${y}`;
const fromServer = (y: number) => `M${X.server},${y} C${X.server - BEND},${y} ${X.hubOut + BEND},${HUB_Y} ${X.hubOut},${HUB_Y}`;
const toClient = (y: number) => `M${X.hubIn},${HUB_Y} C${X.hubIn - BEND},${HUB_Y} ${X.client + BEND},${y} ${X.client},${y}`;

type Kind = 'allow' | 'deny' | 'mask';
interface Flow {
  kind: Kind;
  client: number;
  server: number;
  /** Seconds into the cycle. */
  at: number;
}

/** allow: call reaches a server. deny: stopped at the gateway. mask: a response returns with PII masked. */
const FLOWS: Flow[] = [
  { kind: 'allow', client: 0, server: 0, at: 0 },
  { kind: 'allow', client: 2, server: 1, at: 1.3 },
  { kind: 'deny', client: 1, server: 2, at: 2.7 },
  { kind: 'mask', client: 3, server: 2, at: 4 },
  { kind: 'allow', client: 3, server: 3, at: 5.4 },
  { kind: 'mask', client: 0, server: 0, at: 6.7 },
];

/** One leg lasts 1s of the cycle. `leg` 0 runs first, `leg` 1 right after it. */
function Packet({ path, kind, at, leg }: { path: string; kind: Kind; at: number; leg: 0 | 1 }) {
  const a = leg / CYCLE;
  const b = (leg + 1) / CYCLE;
  const timing = { dur: `${CYCLE}s`, begin: `${at}s`, repeatCount: 'indefinite' } as const;
  return (
    <circle r={4.5} className={`cp-packet cp-${kind}`} opacity={0}>
      <animateMotion {...timing} calcMode="linear" path={path} keyPoints={leg ? '0;0;1;1' : '0;1;1'} keyTimes={leg ? `0;${a};${b};1` : `0;${b};1`} />
      <animate {...timing} attributeName="opacity" values={leg ? '0;0;1;1;0;0' : '1;1;0;0'} keyTimes={leg ? `0;${a - 0.001};${a};${b - 0.004};${b};1` : `0;${b - 0.004};${b};1`} />
    </circle>
  );
}

/**
 * Hero diagram of the control plane: agents and apps on the left, the gateway in the middle, the
 * company's MCP servers on the right. Packets show the three outcomes of a governed call.
 */
export function ControlPlaneArt() {
  const t = useT();
  const reduce = useReducedMotion();
  const [wrap, onScreen] = useOnScreen<HTMLDivElement>();
  const svg = useRef<SVGSVGElement>(null);

  // SMIL keeps running off screen unless paused.
  useEffect(() => {
    if (onScreen) svg.current?.unpauseAnimations();
    else svg.current?.pauseAnimations();
  }, [onScreen]);

  const clients = ['Claude', 'ChatGPT', 'IDE', t('hero.artAgent')];
  const servers = ['/mcp/s/hr', '/mcp/s/finance', '/mcp/s/support', '/mcp/omni'];

  return (
    <div className={`cp ${onScreen ? '' : 'is-paused'}`} ref={wrap} aria-hidden="true">
      <svg ref={svg} viewBox="0 0 460 300" className="cp-svg">
        <text x={0} y={22} className="cp-heading">
          {t('hero.artClients')}
        </text>
        <text x={460} y={22} className="cp-heading" textAnchor="end">
          {t('hero.artServers')}
        </text>

        {ROWS.map((y) => (
          <g key={y}>
            <path d={toHub(y)} className="cp-wire" />
            <path d={toServer(y)} className="cp-wire" />
            <path d={toHub(y)} className="cp-wire cp-wire-flow" />
            <path d={toServer(y)} className="cp-wire cp-wire-flow" />
          </g>
        ))}

        <circle cx={230} cy={HUB_Y} r={62} className="cp-ring" />
        <circle cx={230} cy={HUB_Y} r={62} className="cp-ring cp-ring-2" />
        <g transform="translate(170 112) scale(0.6)">
          <CubeBody />
        </g>
        <text x={230} y={244} className="cp-hub-name" textAnchor="middle">
          MCP Gateway
        </text>
        <text x={230} y={262} className="cp-hub-checks" textAnchor="middle">
          authn · policy · pii · audit
        </text>

        {!reduce &&
          FLOWS.map((f, i) => {
            const cy = ROWS[f.client]!;
            const sy = ROWS[f.server]!;
            if (f.kind === 'mask') {
              return (
                <g key={i}>
                  <Packet path={fromServer(sy)} kind="mask" at={f.at} leg={0} />
                  <Packet path={toClient(cy)} kind="mask" at={f.at} leg={1} />
                </g>
              );
            }
            return (
              <g key={i}>
                <Packet path={toHub(cy)} kind={f.kind} at={f.at} leg={0} />
                {f.kind === 'allow' && <Packet path={toServer(sy)} kind="allow" at={f.at} leg={1} />}
                {f.kind === 'deny' && (
                  <g className="cp-stop" opacity={0}>
                    <circle cx={X.hubIn - 4} cy={HUB_Y} r={11} />
                    <path d={`M${X.hubIn - 8},${HUB_Y - 4} l8,8 m0,-8 l-8,8`} />
                    <animate attributeName="opacity" dur={`${CYCLE}s`} begin={`${f.at}s`} repeatCount="indefinite" values="0;0;1;1;0;0" keyTimes={`0;${0.95 / CYCLE};${1 / CYCLE};${2.2 / CYCLE};${2.6 / CYCLE};1`} />
                  </g>
                )}
              </g>
            );
          })}

        {ROWS.map((y, i) => (
          <g key={y}>
            <rect x={0} y={y - 17} width={X.client} height={34} rx={8} className="cp-node" />
            <circle cx={16} cy={y} r={3.5} className="cp-node-dot" />
            <text x={28} y={y + 4.5} className="cp-node-label">
              {clients[i]}
            </text>
            <rect x={X.server} y={y - 17} width={460 - X.server} height={34} rx={8} className="cp-node" />
            <text x={X.server + 10} y={y + 4} className="cp-node-label cp-mono">
              {servers[i]}
            </text>
          </g>
        ))}
      </svg>
      <div className="cp-legend">
        <span>
          <i className="cp-dot cp-allow" />
          {t('hero.artAllowed')}
        </span>
        <span>
          <i className="cp-dot cp-deny" />
          {t('hero.artDenied')}
        </span>
        <span>
          <i className="cp-dot cp-mask" />
          {t('hero.artMasked')}
        </span>
      </div>
    </div>
  );
}
