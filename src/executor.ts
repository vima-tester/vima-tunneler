import https from "node:https";
import axios from "axios";

export interface JobRequest {
  jobId: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  timeoutMs?: number;
  /** Disable TLS certificate verification for this job (https targets only). */
  insecureTLS?: boolean;
}

export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 300_000;

export function clampTimeout(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, raw));
}

export interface JobResponse {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export const REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

export class NonLocalTargetError extends Error {}
export class BodyTooLargeError extends Error {}

function maxBodyBytes(): number {
  const raw = Number(process.env.VIMA_MAX_BODY_BYTES);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_MAX_BODY_BYTES;
}

function isLocalTarget(rawUrl: string): boolean {
  return candidateTargets(rawUrl).length > 0;
}

function candidateTargets(rawUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [];
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return [];
  }
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!LOCAL_HOSTNAMES.has(host)) {
    return [];
  }
  if (host !== "localhost") {
    return [parsed.toString()];
  }

  const candidates: string[] = [];
  for (const ip of ["127.0.0.1", "::1"]) {
    const alt = new URL(parsed.toString());
    alt.hostname = ip === "::1" ? "[::1]" : ip;
    candidates.push(alt.toString());
  }
  candidates.push(parsed.toString());
  return candidates;
}

// Errors that can only happen before the request reaches the target, so a
// fallback candidate is safe to try without replaying side effects.
const CONNECT_PHASE_CODES = new Set([
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
]);

function isConnectionPhaseError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && CONNECT_PHASE_CODES.has(code);
}

export async function executeRequest(job: JobRequest): Promise<JobResponse> {
  const candidates = candidateTargets(job.url);
  if (candidates.length === 0) {
    throw new NonLocalTargetError(
      `refusing to proxy non-local target: ${job.url}`
    );
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await runOnce(job, candidate);
    } catch (err) {
      lastError = err;
      if (err instanceof BodyTooLargeError) throw err;
      // Only fall through to the next address-family candidate when the
      // failure happened before the request was sent; a mid-flight failure
      // must not replay a non-idempotent request against the other family.
      if (!isConnectionPhaseError(err)) throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("request failed unexpectedly");
}

// Lazily created so plain-http usage never constructs a TLS agent.
let insecureAgent: https.Agent | null = null;

function insecureHttpsAgent(): https.Agent {
  if (insecureAgent === null) {
    insecureAgent = new https.Agent({ rejectUnauthorized: false });
  }
  return insecureAgent;
}

async function runOnce(
  job: JobRequest,
  url: string
): Promise<JobResponse> {
  const response = await axios.request<import("node:stream").Readable>({
    method: job.method,
    url,
    headers: job.headers,
    data: job.bodyBase64 ? Buffer.from(job.bodyBase64, "base64") : undefined,
    responseType: "stream",
    timeout: clampTimeout(job.timeoutMs) ?? REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    validateStatus: () => true,
    httpsAgent: job.insecureTLS ? insecureHttpsAgent() : undefined,
  });

  const limit = maxBodyBytes();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.data) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) {
      response.data.destroy();
      throw new BodyTooLargeError(
        `response body exceeded ${limit} bytes from ${job.url}`
      );
    }
    chunks.push(buf);
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (typeof value === "string") {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      const name = key.toLowerCase();
      // `set-cookie` cannot be comma-joined (values may contain commas, e.g.
      // an Expires date), so separate repeated values with a newline instead.
      headers[name] = value.join(name === "set-cookie" ? "\n" : ", ");
    }
  }

  return {
    status: response.status,
    headers,
    bodyBase64: Buffer.concat(chunks).toString("base64"),
  };
}
