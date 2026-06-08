import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const CHECKER_URL = process.env.CHECKER_URL || "https://check.socks5.cmliussss.net";
const MAX_CANDIDATES = positiveInt(process.env.MAX_CANDIDATES, 300);
const MAX_RESULTS = positiveInt(process.env.MAX_RESULTS, 100);
const CONCURRENCY = positiveInt(process.env.CONCURRENCY, 16);
const TIMEOUT_MS = positiveInt(process.env.TIMEOUT_MS, 35_000);
const MAX_LATENCY_MS = positiveInt(process.env.MAX_LATENCY_MS, 15_000);
const RETEST_PREVIOUS = positiveInt(process.env.RETEST_PREVIOUS, 60);
const EXTRA_CANDIDATES = String(process.env.EXTRA_CANDIDATES || "")
  .split(/[\s,]+/)
  .map(normalizeProxy)
  .filter(Boolean);

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  const response = await fetch(url, {
    headers: { "user-agent": "github-socks5-checker/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const text = await response.text();
  const values = [];
  if ((response.headers.get("content-type") || "").includes("json") || text.trim().startsWith("[")) {
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

async function checkProxy(proxy) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${CHECKER_URL.replace(/\/$/, "")}/check?proxy=${encodeURIComponent(proxy)}`, {
      headers: { accept: "application/json", "user-agent": "github-socks5-checker/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await response.json();
    if (!response.ok || !data.success || !data.exit?.ip) {
      return { proxy, success: false, error: data.error || `HTTP ${response.status}` };
    }

    const parsed = new URL(data.link || proxy);
    const exit = data.exit;
    const location = exit.location || {};
    const asn = exit.asn || {};
    const risk = calculateRisk(exit);
    const latency = Number(data.responseTime || Date.now() - startedAt);

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
      riskScore: risk,
      riskLevel: riskLevel(risk),
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
      success: true,
    };
  } catch (error) {
    return { proxy, success: false, error: error?.name === "TimeoutError" ? "timeout" : String(error?.message || error) };
  }
}

async function mapConcurrent(values, worker, concurrency) {
  const results = new Array(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]);
      const result = results[index];
      console.log(`[${index + 1}/${values.length}] ${result.success ? "OK" : "FAIL"} ${values[index]}`);
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
  .sort((a, b) => a.riskScore - b.riskScore || a.responseTime - b.responseTime);

const preferred = successful.filter((item) =>
  !item.flags.bogon && !item.flags.tor && !item.flags.vpn && !item.flags.datacenter
);
const freshSelection = (preferred.length ? preferred : successful).slice(0, MAX_RESULTS);
const selected = freshSelection.length
  ? freshSelection
  : previous.slice(0, MAX_RESULTS).map((item) => ({ ...item, retainedFromPreviousRun: true }));

await mkdir("data", { recursive: true });
await writeFile("data/socks5.json", `${JSON.stringify(selected, null, 2)}\n`);
await writeFile("data/socks5.txt", `${selected.map((item) => item.proxy).join("\n")}${selected.length ? "\n" : ""}`);
await writeFile("data/results.json", `${JSON.stringify(successful, null, 2)}\n`);
await writeFile("data/status.json", `${JSON.stringify({
  updatedAt: new Date().toISOString(),
  checker: CHECKER_URL,
  sources: sourceUrls.length,
  fetched: fetched.length,
  uniqueCandidates: normalized.length,
  checked: candidates.length,
  successful: successful.length,
  preferred: preferred.length,
  published: selected.length,
  retainedPrevious: freshSelection.length === 0 && selected.length > 0,
}, null, 2)}\n`);

console.log(`Published ${selected.length} nodes (${successful.length} usable, ${preferred.length} preferred)`);
