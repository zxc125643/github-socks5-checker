import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const CHECKER_URL = process.env.CHECKER_URL || "https://check.socks5.cmliussss.net";
const MAX_CANDIDATES = positiveInt(process.env.MAX_CANDIDATES, 300);
const MAX_RESULTS = positiveInt(process.env.MAX_RESULTS, 100);
const CONCURRENCY = positiveInt(process.env.CONCURRENCY, 16);
const TIMEOUT_MS = positiveInt(process.env.TIMEOUT_MS, 35_000);
const MAX_LATENCY_MS = positiveInt(process.env.MAX_LATENCY_MS, 15_000);
const RETEST_PREVIOUS = positiveInt(process.env.RETEST_PREVIOUS, 60);
const LOCAL_CHECK = envBool("LOCAL_CHECK", true);
const LOCAL_TIMEOUT_MS = positiveInt(process.env.LOCAL_TIMEOUT_MS, 10_000);
const LOCAL_MAX_LATENCY_MS = positiveInt(process.env.LOCAL_MAX_LATENCY_MS, 8_000);
const LOCAL_REQUIRED_SUCCESSES = positiveInt(process.env.LOCAL_REQUIRED_SUCCESSES, 2);
const MIN_PURITY_SCORE = envFloat("MIN_PURITY_SCORE", 4.2);
const PUBLISH_ONLY_CLEAN = envBool("PUBLISH_ONLY_CLEAN", false);
const RETAIN_PREVIOUS_ON_EMPTY = envBool("RETAIN_PREVIOUS_ON_EMPTY", false);
const LOCAL_TEST_TARGETS = parseTargets(process.env.LOCAL_TEST_TARGETS || [
  "https://www.gstatic.com/generate_204=204",
  "https://www.cloudflare.com/cdn-cgi/trace=200",
].join(","));
const EXTRA_CANDIDATES = String(process.env.EXTRA_CANDIDATES || "")
  .split(/[\s,]+/)
  .map(normalizeProxy)
  .filter(Boolean);
const execFile = promisify(execFileCallback);

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFloat(name, fallback) {
  const parsed = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeProxy(value) {
  let text = String(value || "").trim();
  if (!text || text.startsWith("#")) return null;
  text = text.split(/\s+/)[0].replace(/[",]+$/g, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `socks5://${text}`;

  try {
    const parsed = new URL(text);
    if (!["socks5:", "socks5h:"].includes(parsed.protocol)) return null;
    const port = Number.parseInt(parsed.port, 10);
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    parsed.protocol = "socks5:";
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseTargets(raw) {
  return String(raw || "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const statusMatch = entry.match(/=(\d{3}(?:[|/;+]\d{3})*)$/);
      const urlText = statusMatch ? entry.slice(0, statusMatch.index) : entry;
      const statusText = statusMatch?.[1];
      const url = new URL(urlText);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error(`Unsupported local test target protocol: ${url.protocol}`);
      }
      const expectedStatus = new Set(
        (statusText || "200,204")
          .split(/[|/;]/)
          .flatMap((part) => part.split("+"))
          .map((part) => Number.parseInt(part, 10))
          .filter((value) => Number.isInteger(value) && value >= 100 && value <= 599)
      );
      if (!expectedStatus.size) expectedStatus.add(200);
      return { url, expectedStatus };
    });
}

async function readText(path, fallback = "") {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

async function readPrevious() {
  try {
    const parsed = JSON.parse(await readFile("data/results.json", "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchSource(url) {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "github-socks5-checker/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseSourceText(await response.text(), response.headers.get("content-type") || "");
  } catch (fetchError) {
    const { stdout } = await execFile("curl", [
      "-L",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "30",
      "--user-agent",
      "github-socks5-checker/1.0",
      url,
    ], { maxBuffer: 5 * 1024 * 1024 });
    console.warn(`Fetch fallback used for ${url}: ${fetchError.message}`);
    return parseSourceText(stdout, "");
  }
}

async function fetchCheckerData(proxy) {
  const url = `${CHECKER_URL.replace(/\/$/, "")}/check?proxy=${encodeURIComponent(proxy)}`;
  const timeoutSeconds = Math.max(1, Math.ceil(TIMEOUT_MS / 1000));
  const { stdout } = await execFile("curl", [
    "-L",
    "--silent",
    "--show-error",
    "--max-time",
    String(timeoutSeconds),
    "--header",
    "accept: application/json",
    "--user-agent",
    "github-socks5-checker/1.0",
    url,
  ], { maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function parseSourceText(text, contentType) {
  const values = [];
  if (contentType.includes("json") || text.trim().startsWith("[")) {
    try {
      const json = JSON.parse(text);
      for (const item of Array.isArray(json) ? json : []) {
        values.push(typeof item === "string" ? item : item.proxy || item.url || item.address);
      }
      return values;
    } catch {
      // Some public sources serve plain text with a JSON content type.
    }
  }
  return text.split(/\r?\n/);
}

function deterministicOrder(values) {
  const day = new Date().toISOString().slice(0, 10);
  return [...values].sort((a, b) => {
    const hashA = createHash("sha256").update(`${day}:${a}`).digest("hex");
    const hashB = createHash("sha256").update(`${day}:${b}`).digest("hex");
    return hashA.localeCompare(hashB);
  });
}

function abuseScore(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function calculateRisk(exit) {
  const companyScore = abuseScore(exit?.company?.abuser_score);
  const asnScore = abuseScore(exit?.asn?.abuser_score);
  const baseScore = ((companyScore + asnScore) / 2) * 5;
  const riskCount = [
    exit?.is_crawler,
    exit?.is_proxy,
    exit?.is_vpn,
    exit?.is_tor,
    exit?.is_abuser,
  ].filter(Boolean).length;
  let score = baseScore + riskCount * 0.15;
  if (exit?.is_bogon) score += 1;
  return Number((score * 100).toFixed(3));
}

function parseRiskLabel(value) {
  const match = String(value || "").match(/\(([^)]+)\)/);
  return match ? match[1].trim().toLowerCase() : "";
}

function riskPenalty(label) {
  return {
    "very low": 0,
    low: 0,
    elevated: 0.2,
    medium: 0.7,
    moderate: 0.7,
    high: 1.8,
    "very high": 3,
    extreme: 3,
  }[label] ?? 0;
}

function purityLevel(score) {
  if (score >= 4.8) return "extremely_clean";
  if (score >= 4.2) return "clean";
  if (score >= 3.2) return "normal";
  if (score >= 2.0) return "high_risk";
  return "extreme_risk";
}

function classifyPurity(exit) {
  if (!exit || exit.error) {
    return {
      status: "unknown",
      score: "",
      percent: "",
      level: "unknown",
      reasons: ["lookup_failed"],
      riskLabel: "",
    };
  }

  let score = 5.0;
  let hardBad = false;
  const reasons = [];
  const penalties = {
    is_bogon: 5.0,
    is_tor: 3.0,
    is_proxy: 2.0,
    is_vpn: 0.8,
    is_abuser: 2.5,
  };
  const hardFlags = new Set(["is_bogon", "is_tor", "is_proxy", "is_abuser"]);
  for (const [flag, penalty] of Object.entries(penalties)) {
    if (exit[flag] === true) {
      reasons.push(flag);
      score -= penalty;
      hardBad = hardBad || hardFlags.has(flag);
    }
  }

  const labels = [
    parseRiskLabel(exit.company?.abuser_score),
    parseRiskLabel(exit.asn?.abuser_score),
  ].filter(Boolean);
  const riskLabel = labels.sort((a, b) => riskPenalty(b) - riskPenalty(a))[0] || "";
  if (riskLabel) {
    score -= riskPenalty(riskLabel);
    if (["high", "very high", "extreme"].includes(riskLabel)) {
      hardBad = true;
      reasons.push(`risk=${riskLabel}`);
    }
  }

  score = Math.max(0, Number(score.toFixed(1)));
  const level = purityLevel(score);
  const status = hardBad || ["high_risk", "extreme_risk"].includes(level)
    ? "dirty"
    : score < MIN_PURITY_SCORE
      ? "warning"
      : "clean";
  return {
    status,
    score,
    percent: `${Math.round((score / 5) * 100)}%`,
    level,
    reasons,
    riskLabel,
  };
}

function riskLevel(percent) {
  if (percent >= 100) return "critical";
  if (percent >= 20) return "high";
  if (percent >= 5) return "elevated";
  if (percent >= 0.25) return "low";
  return "very-low";
}

function countryEmoji(code) {
  const value = String(code || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return "";
  return String.fromCodePoint(...[...value].map((char) => 127397 + char.charCodeAt(0)));
}

function uniqueParts(values) {
  const seen = new Set();
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function formatTextLine(item) {
  const region = uniqueParts([
    item.country_emoji,
    item.country_cn || item.country_en,
    item.country,
  ]).join(" ") || "unknown";
  const score = Number.isFinite(item.purityScore) ? `${item.purityScore}/5` : "unknown";
  const purity = uniqueParts([
    item.purityStatus,
    score,
    item.purityPercent,
  ]).join(" ");
  const latency = Number.isFinite(item.localResponseTime)
    ? `${item.localResponseTime}ms`
    : `${item.responseTime || "unknown"}ms`;
  return `${item.proxy} #${region} /${purity || "unknown"} /${latency}`;
}

async function testHttpThroughProxy(proxy, target) {
  const startedAt = Date.now();
  const timeoutSeconds = Math.max(1, Math.ceil(LOCAL_TIMEOUT_MS / 1000));
  try {
    const { stdout } = await execFile("curl", [
      "-L",
      "--silent",
      "--show-error",
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
      "--max-time",
      String(timeoutSeconds),
      "--connect-timeout",
      String(timeoutSeconds),
      "--proxy",
      proxy,
      "--user-agent",
      "github-socks5-checker-local/1.0",
      target.url.toString(),
    ], { maxBuffer: 256 * 1024 });
    const status = Number.parseInt(stdout.trim().slice(-3), 10) || 0;
    const latency = Date.now() - startedAt;
    return {
      url: target.url.toString(),
      ok: target.expectedStatus.has(status) && latency <= LOCAL_MAX_LATENCY_MS,
      status,
      latency,
    };
  } catch (error) {
    return {
      url: target.url.toString(),
      ok: false,
      status: 0,
      latency: Date.now() - startedAt,
      error: error?.message || String(error),
    };
  }
}

async function localValidateProxy(proxy) {
  if (!LOCAL_CHECK) return { ok: true, required: 0, successes: 0, tests: [] };
  const tests = [];
  for (const target of LOCAL_TEST_TARGETS) {
    try {
      tests.push(await testHttpThroughProxy(proxy, target));
    } catch (error) {
      tests.push({
        url: target.url.toString(),
        ok: false,
        status: 0,
        latency: LOCAL_TIMEOUT_MS,
        error: error?.message || String(error),
      });
    }
  }
  const successes = tests.filter((test) => test.ok).length;
  const required = Math.min(LOCAL_REQUIRED_SUCCESSES, LOCAL_TEST_TARGETS.length);
  return {
    ok: successes >= required,
    required,
    successes,
    tests,
    latency: successes ? Math.round(tests.filter((test) => test.ok).reduce((sum, test) => sum + test.latency, 0) / successes) : LOCAL_TIMEOUT_MS,
  };
}

async function checkProxy(proxy) {
  const startedAt = Date.now();
  try {
    const data = await fetchCheckerData(proxy);
    if (!data.success || !data.exit?.ip) {
      return {
        proxy,
        success: false,
        remotelyUsable: false,
        locallyUsable: false,
        error: data.error || "checker rejected proxy",
      };
    }

    const parsed = new URL(data.link || proxy);
    const exit = data.exit;
    const location = exit.location || {};
    const asn = exit.asn || {};
    const risk = calculateRisk(exit);
    const purity = classifyPurity(exit);
    const latency = Number(data.responseTime || Date.now() - startedAt);
    const local = await localValidateProxy(data.link || proxy);
    if (!local.ok) {
      return {
        proxy: data.link || proxy,
        success: false,
        remotelyUsable: true,
        locallyUsable: false,
        local,
        error: `local validation failed (${local.successes}/${local.required})`,
      };
    }

    return {
      proxy: data.link || proxy,
      protocol: "socks5",
      ip: parsed.hostname.replace(/^\[|\]$/g, ""),
      port: Number(parsed.port),
      clientIp: exit.ip,
      country: String(location.country_code || asn.country || "").toUpperCase(),
      city: location.city || "",
      asn: String(asn.asn || ""),
      asOrganization: asn.org || asn.descr || exit.company?.name || "",
      latitude: location.latitude ?? null,
      longitude: location.longitude ?? null,
      country_cn: location.country || "",
      country_en: location.country || "",
      country_emoji: countryEmoji(location.country_code || asn.country),
      continent: location.continent || "",
      continent_cn: location.continent || "",
      continent_en: location.continent || "",
      responseTime: latency,
      localResponseTime: local.latency,
      local,
      riskScore: risk,
      riskLevel: riskLevel(risk),
      purity,
      purityScore: purity.score,
      purityPercent: purity.percent,
      purityStatus: purity.status,
      purityLevel: purity.level,
      purityReasons: purity.reasons,
      networkType: exit.company?.type || asn.type || "",
      flags: {
        datacenter: Boolean(exit.is_datacenter),
        tor: Boolean(exit.is_tor),
        vpn: Boolean(exit.is_vpn),
        proxy: Boolean(exit.is_proxy),
        abuser: Boolean(exit.is_abuser),
        crawler: Boolean(exit.is_crawler),
        bogon: Boolean(exit.is_bogon),
      },
      checkedAt: new Date().toISOString(),
      remotelyUsable: true,
      locallyUsable: true,
      success: true,
    };
  } catch (error) {
    return {
      proxy,
      success: false,
      remotelyUsable: false,
      locallyUsable: false,
      error: error?.name === "TimeoutError" ? "timeout" : String(error?.message || error),
    };
  }
}

function failureKey(item) {
  if (item?.remotelyUsable === true && item?.locallyUsable === false) {
    return "local_validation_failed";
  }
  const error = String(item?.error || "unknown");
  if (error.includes("checker rejected proxy")) return "checker_rejected";
  if (error.includes("Command failed: curl")) return "checker_request_failed";
  if (error.toLowerCase().includes("timeout")) return "timeout";
  return error.slice(0, 80);
}

function countBy(values, keyFn) {
  return values.reduce((counts, value) => {
    const key = keyFn(value);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

async function mapConcurrent(values, worker, concurrency) {
  const results = new Array(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]);
      const result = results[index];
      const suffix = result.success ? "" : ` (${failureKey(result)})`;
      console.log(`[${index + 1}/${values.length}] ${result.success ? "OK" : "FAIL"} ${values[index]}${suffix}`);
    }
  }));
  return results;
}

const sourceUrls = (await readText("config/sources.txt"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

const previous = await readPrevious();
const previousProxies = previous.slice(0, RETEST_PREVIOUS).map((item) => item.proxy);
const fetched = [];
for (const url of sourceUrls) {
  try {
    const values = await fetchSource(url);
    fetched.push(...values);
    console.log(`Fetched ${values.length} entries from ${url}`);
  } catch (error) {
    console.warn(`Source failed: ${url}: ${error.message}`);
  }
}

const normalized = [...new Set(fetched.map(normalizeProxy).filter(Boolean))];
const candidates = [...new Set([
  ...previousProxies.map(normalizeProxy).filter(Boolean),
  ...EXTRA_CANDIDATES,
  ...deterministicOrder(normalized),
])].slice(0, MAX_CANDIDATES);

if (!candidates.length) throw new Error("No valid SOCKS5 candidates were found");

const checked = await mapConcurrent(candidates, checkProxy, CONCURRENCY);
const successful = checked
  .filter((item) => item.success && item.responseTime <= MAX_LATENCY_MS)
  .sort((a, b) => {
    const purityA = Number.isFinite(a.purityScore) ? a.purityScore : -1;
    const purityB = Number.isFinite(b.purityScore) ? b.purityScore : -1;
    return purityB - purityA || a.riskScore - b.riskScore || a.localResponseTime - b.localResponseTime || a.responseTime - b.responseTime;
  });

const preferred = successful.filter((item) =>
  item.locallyUsable &&
  item.purityStatus === "clean" &&
  !item.flags.bogon &&
  !item.flags.tor &&
  !item.flags.vpn &&
  !item.flags.proxy
);
const preferredSet = new Set(preferred.map((item) => item.proxy));
const fallbackSource = PUBLISH_ONLY_CLEAN
  ? successful.filter((item) => item.purityStatus === "clean")
  : successful;
const fallback = fallbackSource.filter((item) => !preferredSet.has(item.proxy));
const freshSelection = [...preferred, ...fallback].slice(0, MAX_RESULTS);
const selected = freshSelection.length || !RETAIN_PREVIOUS_ON_EMPTY
  ? freshSelection
  : previous.slice(0, MAX_RESULTS).map((item) => ({ ...item, retainedFromPreviousRun: true }));

const failed = checked.filter((item) => !item.success);
const puritySummary = countBy(successful, (item) => item.purityStatus || "unknown");

await mkdir("data", { recursive: true });
await writeFile("data/socks5.json", `${JSON.stringify(selected, null, 2)}\n`);
await writeFile("data/socks5.txt", `${selected.map(formatTextLine).join("\n")}${selected.length ? "\n" : ""}`);
await writeFile("data/results.json", `${JSON.stringify(successful, null, 2)}\n`);
await writeFile("data/status.json", `${JSON.stringify({
  updatedAt: new Date().toISOString(),
  checker: CHECKER_URL,
  sources: sourceUrls.length,
  fetched: fetched.length,
  uniqueCandidates: normalized.length,
  checked: candidates.length,
  successful: successful.length,
  remoteFailures: failed.filter((item) => item.remotelyUsable === false).length,
  localFailures: failed.filter((item) => item.remotelyUsable === true && item.locallyUsable === false).length,
  failureReasons: countBy(failed, failureKey),
  preferred: preferred.length,
  locallyValidated: LOCAL_CHECK,
  localTargets: LOCAL_TEST_TARGETS.map((target) => target.url.toString()),
  localRequiredSuccesses: Math.min(LOCAL_REQUIRED_SUCCESSES, LOCAL_TEST_TARGETS.length),
  minPurityScore: MIN_PURITY_SCORE,
  publishOnlyClean: PUBLISH_ONLY_CLEAN,
  purity: puritySummary,
  clean: successful.filter((item) => item.purityStatus === "clean").length,
  published: selected.length,
  retainedPrevious: freshSelection.length === 0 && selected.length > 0,
}, null, 2)}\n`);

console.log(`Published ${selected.length} nodes (${successful.length} locally usable, ${preferred.length} clean preferred)`);
