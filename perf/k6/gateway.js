// Data plane load (F11.2): 200 rps of tools/call on the gateway, then the same load
// directly on the upstream (baseline). Gateway overhead ≈ p95(gateway) − p95(upstream).
//
//   docker run --rm -v $PWD/perf/k6:/k6 -e TOKEN=... -e GATEWAY=http://host.docker.internal:4100 \
//     -e UPSTREAM=http://host.docker.internal:4010 grafana/k6 run /k6/gateway.js
import http from 'k6/http';
import { check } from 'k6';

const GATEWAY = __ENV.GATEWAY || 'http://host.docker.internal:4100';
const UPSTREAM = __ENV.UPSTREAM || 'http://host.docker.internal:4010';
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || '60s';
const TOOL = __ENV.TOOL || 'rh_colaborador_get';

export const options = {
  discardResponseBodies: false,
  scenarios: {
    gateway: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 50, maxVUs: 400, exec: 'gateway' },
    upstream: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 50, maxVUs: 400, exec: 'upstream', startTime: '70s' },
  },
  thresholds: {
    'http_req_failed{scenario:gateway}': ['rate<0.01'],
    'http_req_duration{scenario:gateway}': ['p(95)<100'],
    // only so k6 breaks down the baseline in the summary
    'http_req_duration{scenario:upstream}': ['p(95)<1000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const ids = Array.from({ length: 50 }, (_, i) => `col-${String(i + 1).padStart(5, '0')}`);

export function gateway() {
  const id = ids[Math.floor(Math.random() * ids.length)];
  const res = http.post(
    `${GATEWAY}/mcp`,
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL, arguments: { id } } }),
    {
      headers: { authorization: `Bearer ${__ENV.TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      tags: { scenario: 'gateway' },
    },
  );
  check(res, { 'gateway 200': (r) => r.status === 200 && !r.body.includes('"isError":true') });
}

export function upstream() {
  const id = ids[Math.floor(Math.random() * ids.length)];
  const res = http.get(`${UPSTREAM}/colaboradores/${id}`, { headers: { 'x-api-key': 'fake-api-key' }, tags: { scenario: 'upstream' } });
  check(res, { 'upstream 200': (r) => r.status === 200 });
}
