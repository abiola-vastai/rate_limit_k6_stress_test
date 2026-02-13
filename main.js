// rate_limit_advanced.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";
const BASE_URL = __ENV.BASE_URL || 'http://localhost:5002';
const URL = `${BASE_URL}/api/v0/bundles/`;

const blocked = new Counter('blocked_requests');
const allowed = new Counter('allowed_requests');
const rate_limit_overhead = new Trend('rate_limit_check_time');
const expectedStatuses = http.expectedStatuses(200, 429);

function retryAfterToSeconds(value) {
  if (!value) return 0;

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) {
    return 0;
  }

  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

export const options = {
  scenarios: {
    // Scenario 1: Sustained load at limit
    sustained_load: {
      exec: 'advancedTraffic',
      executor: 'constant-arrival-rate',
      rate: 50, // Adjust to your limit
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 5,
      maxVUs: 20,
      startTime: '0s',
    },

    // Scenario 2: Burst attack
    burst_attack: {
      exec: 'advancedTraffic',
      executor: 'constant-arrival-rate',
      rate: 500, // Way over limit
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 20,
      maxVUs: 100,
      startTime: '2m', // Starts after sustained load
    },

    // Scenario 3: Multiple different users
    distributed_users: {
      exec: 'advancedTraffic',
      executor: 'per-vu-iterations',
      vus: 20,
      iterations: 10,
      maxDuration: '1m',
      startTime: '2m30s',
    },

    // Scenario 4: Window boundary race-condition checks (duration-based to avoid
    // misleading "0/N shared iterations" when requests are slow under contention)
    window_boundary: {
      exec: 'windowBoundary',
      executor: 'constant-vus',
      vus: 10,
      duration: '30s',
      gracefulStop: '5s',
      startTime: '3m30s',
    },
  },

  thresholds: {
    // 429 median is ~3ms (the rate limiter itself is fast). The p95 tail (up to ~2s)
    // is Gunicorn worker contention: ratelimitapi() runs INSIDE the view handler, so
    // a would-be 429 must first be picked up by a sync worker. During burst_attack,
    // all workers are blocked on search_asks_ DB queries (~1-3s each).
    // TODO: tighten to p(95)<50 once Redis tween short-circuits before the view.
    'http_req_duration{status:429}': ['p(95)<2000'],
    'blocked_requests': ['count>0'], // Expect some blocks
    // k6 counts 429 as "failed" — set expected_response tag to handle this
    'http_req_failed': ['rate<0.8'], // Most requests will be 429 from shared IP; relax
  },
};

export function advancedTraffic() {

  const params = {
    tags: { name: 'bundles_search' },
    responseCallback: expectedStatuses,
  };

  const response = http.get(URL, params);
  rate_limit_overhead.add(response.timings.duration);

  // k6 canonicalizes headers via Go's textproto.CanonicalMIMEHeaderKey:
  //   X-RateLimit-Remaining → X-Ratelimit-Remaining  (capital L lowered)
  //   X-RateLimit-Limit     → X-Ratelimit-Limit
  //   X-RateLimit-Reset     → X-Ratelimit-Reset
  check(response, {
    'status OK or rate limited': (r) => r.status === 200 || r.status === 429,
    'has rate limit headers': (r) => r.headers['X-Ratelimit-Remaining'] !== undefined,
    '429 has Retry-After': (r) => r.status !== 429 || r.headers['Retry-After'] !== undefined,
  });

  if (response.status === 429) {
    blocked.add(1);
  } else if (response.status === 200) {
    allowed.add(1);
  }

  // Small delay to avoid overwhelming the system unnecessarily
  sleep(0.1);
}

export function windowBoundary() {
  // Probe current bucket state
  const probe = http.get(URL, {
    tags: { name: 'bundles_probe' },
    responseCallback: expectedStatuses,
  });
  const retryAfter = retryAfterToSeconds(probe.headers['Retry-After']);

  // If rate-limited, sleep until the bucket should refill, then race at the boundary
  if (retryAfter > 0) {
    sleep(Math.min(retryAfter, 3));
  }

  // Batch requests right at the refill boundary to test concurrent access
  const responses = http.batch([
    ['GET', URL, null, { tags: { name: 'window_boundary_1' }, responseCallback: expectedStatuses }],
    ['GET', URL, null, { tags: { name: 'window_boundary_2' }, responseCallback: expectedStatuses }],
    ['GET', URL, null, { tags: { name: 'window_boundary_3' }, responseCallback: expectedStatuses }],
  ]);

  responses.forEach((response, index) => {
    check(response, {
      [`Request ${index} has status`]: (r) => r.status > 0,
      'status OK or rate limited': (r) => r.status === 200 || r.status === 429,
      'has rate limit headers': (r) => r.headers['X-Ratelimit-Remaining'] !== undefined,
      '429 has Retry-After': (r) => r.status !== 429 || r.headers['Retry-After'] !== undefined,
    });

    if (response.status === 429) {
      blocked.add(1);
    } else if (response.status === 200) {
      allowed.add(1);
    }
  });
}

export default advancedTraffic;

export function handleSummary(data) {
  return {
    "summary.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}