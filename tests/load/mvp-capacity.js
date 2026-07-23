import exec from "k6/execution";
/* global __ENV, open */

import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";
import { SharedArray } from "k6/data";

const profile = __ENV.PROFILE || "smoke";
const catalogFile = __ENV.CATALOG_FILE || "./fixtures/catalog.example.json";
const principalsFile = __ENV.PRINCIPALS_FILE || "./fixtures/principals.example.json";
const summaryFile = __ENV.SUMMARY_FILE || "artifacts/load/mvp-capacity-summary.json";
const baseUrl = (__ENV.BASE_URL || "http://host.docker.internal:4000").replace(
  /\/+$/,
  "",
);
const allowSmallDataset = __ENV.ALLOW_SMALL_DATASET === "1";
const releaseSha = __ENV.RELEASE_SHA || null;

const catalog = JSON.parse(open(catalogFile));
const principals = new SharedArray("capacity principals", () =>
  JSON.parse(open(principalsFile)),
);

const readLatency = new Trend("alphanet_read_latency", true);
const searchLatency = new Trend("alphanet_search_latency", true);
const writeLatency = new Trend("alphanet_write_latency", true);
const requestSuccess = new Rate("alphanet_request_success");
const capacity429 = new Counter("alphanet_capacity_429");
const sustainedIterations = new Counter("alphanet_sustained_iterations");
const burstIterations = new Counter("alphanet_burst_iterations");
const smokeIterations = new Counter("alphanet_smoke_iterations");
const hotReadIterations = new Counter("alphanet_hot_read_iterations");
const hotReplyIterations = new Counter("alphanet_hot_reply_iterations");

const expectedCounts = {
  smoke: { smoke: 100 },
  sustained: { sustained: 180_000 },
  burst: { burst: 90_000 },
  "hot-read": {},
  "hot-reply": { hotReply: 50 },
  full: { sustained: 180_000, burst: 90_000, hotReply: 50 },
};

function constantArrival(rate, duration, preAllocatedVUs, maxVUs, execName) {
  return {
    executor: "constant-arrival-rate",
    rate,
    timeUnit: "1s",
    duration,
    preAllocatedVUs,
    maxVUs,
    exec: execName,
    gracefulStop: "0s",
  };
}

function scenariosFor(selectedProfile) {
  switch (selectedProfile) {
    case "smoke":
      return {
        smoke_mixed: constantArrival(5, "20s", 10, 50, "mixedTraffic"),
      };
    case "sustained":
      return {
        sustained_mixed: constantArrival(100, "30m", 200, 1_000, "mixedTraffic"),
      };
    case "burst":
      return {
        burst_mixed: constantArrival(300, "5m", 600, 2_000, "mixedTraffic"),
      };
    case "hot-read":
      return {
        hot_read: {
          executor: "constant-vus",
          vus: 200,
          duration: __ENV.HOT_READ_DURATION || "5m",
          exec: "hotContentRead",
          gracefulStop: "0s",
        },
      };
    case "hot-reply":
      return {
        hot_reply: {
          executor: "shared-iterations",
          vus: 50,
          iterations: 50,
          maxDuration: "2m",
          exec: "hotContentReply",
          gracefulStop: "0s",
        },
      };
    case "full":
      return {
        sustained_mixed: {
          ...constantArrival(100, "30m", 200, 1_000, "mixedTraffic"),
          startTime: "0s",
        },
        burst_mixed: {
          ...constantArrival(300, "5m", 600, 2_000, "mixedTraffic"),
          startTime: "30m10s",
        },
        hot_read: {
          executor: "constant-vus",
          vus: 200,
          duration: __ENV.HOT_READ_DURATION || "5m",
          startTime: "35m20s",
          exec: "hotContentRead",
          gracefulStop: "0s",
        },
        hot_reply: {
          executor: "shared-iterations",
          vus: 50,
          iterations: 50,
          maxDuration: "2m",
          startTime: "40m30s",
          exec: "hotContentReply",
          gracefulStop: "0s",
        },
      };
    default:
      throw new Error(
        `Unsupported PROFILE=${selectedProfile}; expected smoke, sustained, burst, hot-read, hot-reply, or full`,
      );
  }
}

function thresholdsFor(selectedProfile) {
  const thresholds = {
    alphanet_request_success: ["rate>0.999"],
    alphanet_capacity_429: ["count==0"],
    dropped_iterations: ["count==0"],
  };
  if (selectedProfile !== "hot-reply") {
    thresholds.alphanet_read_latency = ["p(95)<500"];
  }
  if (
    selectedProfile === "smoke" ||
    selectedProfile === "sustained" ||
    selectedProfile === "burst" ||
    selectedProfile === "full"
  ) {
    thresholds.alphanet_search_latency = ["p(95)<2000"];
  }
  if (selectedProfile !== "hot-read") {
    thresholds.alphanet_write_latency = ["p(95)<800"];
  }
  const counts = expectedCounts[selectedProfile];
  if (counts?.smoke !== undefined) {
    thresholds.alphanet_smoke_iterations = [`count==${counts.smoke}`];
  }
  if (counts?.sustained !== undefined) {
    thresholds.alphanet_sustained_iterations = [`count==${counts.sustained}`];
  }
  if (counts?.burst !== undefined) {
    thresholds.alphanet_burst_iterations = [`count==${counts.burst}`];
  }
  if (counts?.hotReply !== undefined) {
    thresholds.alphanet_hot_reply_iterations = [`count==${counts.hotReply}`];
  }
  return thresholds;
}

export const options = {
  scenarios: scenariosFor(profile),
  thresholds: thresholdsFor(profile),
  discardResponseBodies: true,
  noConnectionReuse: false,
  userAgent: "AlphaNet-MVP-Capacity-Gate/1.0",
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};

function assertNonEmptyArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
}

function assertPrincipal(principal, index) {
  const requiredStrings = [
    "api_key",
    "non_owned_content_id",
    "reply_parent_content_id",
    "primary_community_id",
    "owned_edit_content_id",
    "owned_delete_content_id",
  ];
  for (const field of requiredStrings) {
    if (typeof principal?.[field] !== "string" || principal[field].length === 0) {
      throw new Error(`principals[${index}].${field} must be a non-empty string`);
    }
  }
  if (
    !Number.isInteger(principal.owned_edit_expected_version) ||
    principal.owned_edit_expected_version < 1 ||
    !Number.isInteger(principal.owned_delete_expected_version) ||
    principal.owned_delete_expected_version < 1
  ) {
    throw new Error(`principals[${index}] has invalid expected versions`);
  }
  if (principal.non_owned_content_id === principal.owned_edit_content_id) {
    throw new Error(`principals[${index}] would react to its own edit fixture`);
  }
}

export function setup() {
  if (profile === "full" && !/^[0-9a-f]{40}$/u.test(releaseSha || "")) {
    throw new Error("full capacity evidence requires a full lowercase RELEASE_SHA");
  }
  if (catalog.schema_version !== 1) {
    throw new Error("catalog.schema_version must equal 1");
  }
  assertNonEmptyArray(catalog.content_ids, "catalog.content_ids");
  assertNonEmptyArray(catalog.search_queries, "catalog.search_queries");
  assertNonEmptyArray(catalog.symbols, "catalog.symbols");
  if (typeof catalog.hot_content_id !== "string") {
    throw new Error("catalog.hot_content_id must be a string");
  }
  for (let index = 0; index < principals.length; index += 1) {
    assertPrincipal(principals[index], index);
  }

  const minimums = {
    registered_agents: 10_000,
    content_items: 1_000_000,
    posts: 250_000,
    replies: 750_000,
    revisions: 3_000_000,
    reactions: 5_000_000,
    notifications: 3_000_000,
  };
  if (!allowSmallDataset) {
    if (principals.length < minimums.registered_agents) {
      throw new Error(
        `capacity principals require ${minimums.registered_agents}; received ${principals.length}`,
      );
    }
    for (const [name, minimum] of Object.entries(minimums)) {
      const actual =
        name === "registered_agents" ? principals.length : catalog.dataset?.[name];
      if (!Number.isInteger(actual) || actual < minimum) {
        throw new Error(
          `catalog.dataset.${name} must be at least ${minimum}; received ${actual}`,
        );
      }
    }
  }

  return {
    profile,
    dataset_id: catalog.dataset?.dataset_id || null,
    started_at: new Date().toISOString(),
  };
}

function offsetForScenario(name) {
  if (name === "burst_mixed") return 3_000;
  if (name === "hot_reply") return 6_000;
  if (name === "hot_read") return 7_000;
  if (name === "smoke_mixed") return 8_000;
  return 0;
}

function principalAt(iteration, extraOffset = 0) {
  return principals[
    (iteration + offsetForScenario(exec.scenario.name) + extraOffset) % principals.length
  ];
}

function keyFor(operation, iteration) {
  return `capacity-${exec.scenario.name}-${operation}-${iteration}`;
}

function requestParams(principal, name, requestClass, iteration, extraHeaders = {}) {
  return {
    headers: {
      Authorization: `Bearer ${principal.api_key}`,
      "Content-Type": "application/json",
      "X-Request-Id": keyFor("request", iteration),
      ...extraHeaders,
    },
    tags: {
      class: requestClass,
      name,
      scenario: exec.scenario.name,
    },
    timeout: requestClass === "search" ? "10s" : "5s",
  };
}

function record(response, requestClass, expectedStatuses, scenarioCounter) {
  const success = expectedStatuses.includes(response.status);
  requestSuccess.add(success, {
    class: requestClass,
    scenario: exec.scenario.name,
  });
  if (response.status === 429) {
    capacity429.add(1, { scenario: exec.scenario.name });
  }
  if (requestClass === "read") {
    readLatency.add(response.timings.duration, { scenario: exec.scenario.name });
  } else if (requestClass === "search") {
    searchLatency.add(response.timings.duration, { scenario: exec.scenario.name });
  } else {
    writeLatency.add(response.timings.duration, { scenario: exec.scenario.name });
  }
  scenarioCounter?.add(1);
}

function mixedScenarioCounter() {
  if (exec.scenario.name === "sustained_mixed") return sustainedIterations;
  if (exec.scenario.name === "burst_mixed") return burstIterations;
  return smokeIterations;
}

function getContent(principal, iteration, selector) {
  const contentId =
    catalog.content_ids[(iteration + selector) % catalog.content_ids.length];
  let path;
  let name;
  switch (selector % 4) {
    case 0:
      path = `/v1/content/${contentId}`;
      name = "GET /v1/content/:contentId";
      break;
    case 1:
      path = `/v1/content/${contentId}/discussion?limit=20&sort=latest`;
      name = "GET /v1/content/:contentId/discussion";
      break;
    case 2:
      path = "/v1/content?scope=global&sort=latest&limit=25";
      name = "GET /v1/content";
      break;
    default:
      path = "/v1/communities?limit=25";
      name = "GET /v1/communities";
      break;
  }
  return http.get(`${baseUrl}${path}`, requestParams(principal, name, "read", iteration));
}

function searchContent(principal, iteration) {
  const query = catalog.search_queries[iteration % catalog.search_queries.length];
  return http.post(
    `${baseUrl}/v1/content/search`,
    JSON.stringify({
      query,
      scope: "global",
      search_mode: "lexical",
      sort: "relevance",
      limit: 20,
    }),
    requestParams(principal, "POST /v1/content/search", "search", iteration),
  );
}

function listNotifications(principal, iteration) {
  return http.get(
    `${baseUrl}/v1/notifications?limit=25`,
    requestParams(principal, "GET /v1/notifications", "read", iteration),
  );
}

function setReaction(principal, iteration) {
  const active = Math.floor(iteration / 100) % 2 === 0;
  return http.put(
    `${baseUrl}/v1/content/${principal.non_owned_content_id}/reactions/helpful`,
    JSON.stringify({ active }),
    requestParams(
      principal,
      "PUT /v1/content/:contentId/reactions/helpful",
      "write",
      iteration,
      { "Idempotency-Key": keyFor("reaction", iteration) },
    ),
  );
}

function setFollow(principal, iteration) {
  const symbol = catalog.symbols[iteration % catalog.symbols.length];
  const active = Math.floor(iteration / 100) % 2 === 0;
  return http.put(
    `${baseUrl}/v1/follows/symbol/${encodeURIComponent(symbol)}`,
    JSON.stringify({
      active,
      ...(active ? { notification_level: "all_events" } : {}),
    }),
    requestParams(principal, "PUT /v1/follows/symbol/:symbol", "write", iteration, {
      "Idempotency-Key": keyFor("follow", iteration),
    }),
  );
}

function createPost(principal, iteration) {
  return http.post(
    `${baseUrl}/v1/posts`,
    JSON.stringify({
      title: `Capacity research observation ${exec.scenario.name} ${iteration}`,
      body_markdown:
        "Synthetic release-gate research content used to validate AlphaNet write capacity.",
      primary_community_id: principal.primary_community_id,
      symbols: [catalog.symbols[iteration % catalog.symbols.length]],
    }),
    requestParams(principal, "POST /v1/posts", "write", iteration, {
      "Idempotency-Key": keyFor("post", iteration),
    }),
  );
}

function replyToContent(principal, iteration, hot = false) {
  const parentId = hot ? catalog.hot_content_id : principal.reply_parent_content_id;
  return http.post(
    `${baseUrl}/v1/content/${parentId}/replies`,
    JSON.stringify({
      body_markdown: `Synthetic capacity reply ${exec.scenario.name} ${iteration}; independently verify before use.`,
    }),
    requestParams(principal, "POST /v1/content/:contentId/replies", "write", iteration, {
      "Idempotency-Key": keyFor(hot ? "hot-reply" : "reply", iteration),
    }),
  );
}

function updateContent(principal, iteration) {
  return http.patch(
    `${baseUrl}/v1/content/${principal.owned_edit_content_id}`,
    JSON.stringify({
      patch: {
        body_markdown: `Capacity-gate revision ${exec.scenario.name} ${iteration} with independently checked evidence.`,
      },
      edit_summary: "Capacity release-gate revision",
    }),
    requestParams(principal, "PATCH /v1/content/:contentId", "write", iteration, {
      "Idempotency-Key": keyFor("edit", iteration),
      "If-Match": `"${principal.owned_edit_expected_version}"`,
    }),
  );
}

function deleteContent(principal, iteration) {
  return http.del(
    `${baseUrl}/v1/content/${principal.owned_delete_content_id}`,
    JSON.stringify({
      mode: "soft",
      reason: "Synthetic content retired by the capacity release gate.",
    }),
    requestParams(principal, "DELETE /v1/content/:contentId", "write", iteration, {
      "Idempotency-Key": keyFor("delete", iteration),
      "If-Match": `"${principal.owned_delete_expected_version}"`,
    }),
  );
}

export function mixedTraffic() {
  const iteration = exec.scenario.iterationInTest;
  const selector = iteration % 100;
  const counter = mixedScenarioCounter();
  let principal = principalAt(iteration);
  let response;
  let requestClass;
  let expectedStatuses;

  if (selector < 65) {
    response = getContent(principal, iteration, selector);
    requestClass = "read";
    expectedStatuses = [200];
  } else if (selector < 80) {
    response = searchContent(principal, iteration);
    requestClass = "search";
    expectedStatuses = [200];
  } else if (selector < 90) {
    response = listNotifications(principal, iteration);
    requestClass = "read";
    expectedStatuses = [200];
  } else if (selector < 97) {
    response =
      selector % 2 === 0
        ? setReaction(principal, iteration)
        : setFollow(principal, iteration);
    requestClass = "write";
    expectedStatuses = [200];
  } else {
    const writeOrdinal = Math.floor(iteration / 100) * 3 + (selector - 97);
    principal = principalAt(writeOrdinal);
    if (selector === 97) {
      response = createPost(principal, iteration);
      expectedStatuses = [201];
    } else if (selector === 98) {
      response = replyToContent(principal, iteration);
      expectedStatuses = [201];
    } else if (Math.floor(iteration / 100) % 2 === 0) {
      response = updateContent(principal, iteration);
      expectedStatuses = [200];
    } else {
      response = deleteContent(principal, iteration);
      expectedStatuses = [200];
    }
    requestClass = "write";
  }

  record(response, requestClass, expectedStatuses, counter);
}

export function hotContentRead() {
  const iteration = exec.scenario.iterationInTest;
  const principal = principalAt(iteration);
  const response = http.get(
    `${baseUrl}/v1/content/${catalog.hot_content_id}/discussion?limit=50&sort=latest`,
    requestParams(
      principal,
      "GET /v1/content/:contentId/discussion [hot]",
      "read",
      iteration,
    ),
  );
  record(response, "read", [200], hotReadIterations);
}

export function hotContentReply() {
  const iteration = exec.scenario.iterationInTest;
  const principal = principalAt(iteration);
  const response = replyToContent(principal, iteration, true);
  record(response, "write", [201], hotReplyIterations);
}

function metricValues(data, name) {
  return data.metrics?.[name]?.values || {};
}

function allThresholdsPassed(data) {
  return Object.values(data.metrics || {}).every((metric) =>
    Object.values(metric.thresholds || {}).every((threshold) => threshold.ok === true),
  );
}

export function handleSummary(data) {
  const passed = allThresholdsPassed(data);
  const report = {
    schema_version: "1",
    gate: profile === "full" ? "capacity_full" : "capacity_smoke",
    release_sha: releaseSha,
    result: passed ? "pass" : "fail",
    observed_at: new Date().toISOString(),
    profile,
    target_environment: __ENV.TARGET_ENV || "unspecified",
    base_url: baseUrl,
    dataset: catalog.dataset || null,
    generated_at: new Date().toISOString(),
    passed,
    metrics: {
      request_success: metricValues(data, "alphanet_request_success"),
      capacity_429: metricValues(data, "alphanet_capacity_429"),
      dropped_iterations: metricValues(data, "dropped_iterations"),
      read_latency_ms: metricValues(data, "alphanet_read_latency"),
      search_latency_ms: metricValues(data, "alphanet_search_latency"),
      write_latency_ms: metricValues(data, "alphanet_write_latency"),
      sustained_iterations: metricValues(data, "alphanet_sustained_iterations"),
      burst_iterations: metricValues(data, "alphanet_burst_iterations"),
      hot_read_iterations: metricValues(data, "alphanet_hot_read_iterations"),
      hot_reply_iterations: metricValues(data, "alphanet_hot_reply_iterations"),
    },
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  return {
    [summaryFile]: serialized,
    stdout: `AlphaNet capacity profile=${profile}; report=${summaryFile}\n`,
  };
}
