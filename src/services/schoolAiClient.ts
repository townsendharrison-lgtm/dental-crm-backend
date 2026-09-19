/**
 * Thin internal client for the Python school-ai-service.
 *
 * Auth: shared secret header `X-School-AI-Key` (INTERNAL_API_SECRET on Python,
 * SCHOOL_AI_INTERNAL_KEY on Node). Not for browser use.
 *
 * Job completion: **polling** `getJob(jobId)` until status is succeeded/failed/
 * cancelled. Webhooks are not used in Phase 8 (simpler ops; workers already
 * persist durable job rows).
 */
const DEFAULT_TIMEOUT_MS = 60_000;

export type SchoolAiJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export class SchoolAiClientError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'SchoolAiClientError';
    this.status = status;
    this.body = body;
  }
}

export type SchoolAiClientOptions = {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function config(options: SchoolAiClientOptions = {}) {
  const baseUrl = (options.baseUrl || process.env.SCHOOL_AI_SERVICE_URL || process.env.AI_SERVER_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
  const apiKey = options.apiKey ?? process.env.SCHOOL_AI_INTERNAL_KEY ?? '';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  return { baseUrl, apiKey, timeoutMs, fetchImpl };
}

async function request<T>(
  method: string,
  path: string,
  options: SchoolAiClientOptions & { body?: unknown; formData?: FormData } = {},
): Promise<T> {
  const { baseUrl, apiKey, timeoutMs, fetchImpl } = config(options);
  const headers: Record<string, string> = {};
  if (apiKey) headers['X-School-AI-Key'] = apiKey;
  let body: string | FormData | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const detail = typeof parsed === 'object' && parsed && 'detail' in parsed
      ? String((parsed as { detail: unknown }).detail)
      : `School AI request failed (${response.status})`;
    throw new SchoolAiClientError(detail, response.status, parsed);
  }
  return parsed as T;
}

export function createSchoolAiClient(options: SchoolAiClientOptions = {}) {
  return {
    health: () => request<{ status: string }>('GET', '/health', options),

    createSchool: (name: string, officialUrl: string) =>
      request<{ school_id: string }>('POST', '/schools', {
        ...options,
        body: { name, official_url: officialUrl },
      }),

    uploadDocument: async (schoolId: string, file: Blob | ArrayBuffer | Uint8Array, filename: string, forceRefresh = false) => {
      const form = new FormData();
      const blob = file instanceof Blob ? file : new Blob([file]);
      form.append('file', blob, filename);
      const query = forceRefresh ? '?force_refresh=true' : '';
      return request<{ document_id: string; job_id: string; status: string; cached: boolean }>(
        'POST',
        `/schools/${schoolId}/documents${query}`,
        { ...options, formData: form, timeoutMs: options.timeoutMs ?? 120_000 },
      );
    },

    enqueueResearch: (schoolId: string, forceRefresh = false) =>
      request<{ job_id: string; status: string; cached: boolean }>(
        'POST',
        `/schools/${schoolId}/research${forceRefresh ? '?force_refresh=true' : ''}`,
        options,
      ),

    crawlUrl: (schoolId: string, url: string, forceRefresh = false) =>
      request<{ job_id: string; status: string; cached: boolean }>(
        'POST',
        `/schools/${schoolId}/crawl-url${forceRefresh ? '?force_refresh=true' : ''}`,
        { ...options, body: { url } },
      ),

    getSchoolFacts: (schoolId: string) =>
      request<{ school_id: string; fact_count: number; facts: Array<Record<string, unknown>> }>(
        'GET',
        `/schools/${schoolId}/facts`,
        options,
      ),

    getJob: (jobId: string) =>
      request<{
        job_id: string;
        type: string;
        status: SchoolAiJobStatus;
        attempts: number;
        error: unknown;
        document_id?: string | null;
        school_id?: string | null;
        result?: unknown;
      }>('GET', `/jobs/${jobId}`, options),

    listJobs: (query: { status?: SchoolAiJobStatus; schoolId?: string; limit?: number } = {}) => {
      const params = new URLSearchParams();
      if (query.status) params.set('status', query.status);
      if (query.schoolId) params.set('school_id', query.schoolId);
      if (query.limit != null) params.set('limit', String(query.limit));
      const qs = params.toString();
      return request<{ jobs: Array<{
        job_id: string;
        type: string;
        status: SchoolAiJobStatus;
        attempts: number;
        school_id?: string | null;
        error?: unknown;
      }>; count: number }>('GET', `/jobs${qs ? `?${qs}` : ''}`, options);
    },

    getDocumentFacts: (documentId: string) =>
      request<{ job_id: string; status: string; facts: unknown[] }>('GET', `/documents/${documentId}/facts`, options),

    recomputeNormalization: () =>
      request<{ method: string; factor_count: number; factors: unknown[] }>('POST', '/normalization/recompute', options),

    generateRubric: (schoolId: string) =>
      request<{ school_id: string; factor_count: number; rubric_status: string; factors: unknown[] }>(
        'POST',
        `/schools/${schoolId}/rubric/generate`,
        options,
      ),

    getRubric: (schoolId: string) =>
      request<{ school_id: string; rubric_status: string; factors: unknown[] }>('GET', `/schools/${schoolId}/rubric`, options),

    overrideRubricFactor: (
      schoolId: string,
      factorKey: string,
      payload: {
        value?: unknown;
        weight?: number;
        confidence?: number;
        reasoning: string;
        editor: string;
        reason: string;
        source_urls?: string[];
      },
    ) =>
      request('PATCH', `/schools/${schoolId}/rubric/${encodeURIComponent(factorKey)}`, {
        ...options,
        body: payload,
      }),

    approveRubric: (schoolId: string, editor: string) =>
      request<{ school_id: string; rubric_status: string }>('POST', `/schools/${schoolId}/rubric/approve`, {
        ...options,
        body: { editor },
      }),

    scoreStudent: (schoolId: string, studentId: string, attributes: Record<string, unknown> = {}) =>
      request<{
        school_id: string;
        student_id: string;
        score: number;
        score_kind: string;
        per_factor_breakdown: unknown[];
        skipped: unknown[];
        reasoning: string;
        scoring_run_id?: string;
      }>('POST', `/schools/${schoolId}/score`, {
        ...options,
        body: { student_id: studentId, attributes },
      }),

    /**
     * Poll until the job reaches a terminal status.
     * Preferred over webhooks for Phase 8: durable job rows already exist.
     */
    waitForJob: async (
      jobId: string,
      poll: { intervalMs?: number; timeoutMs?: number } = {},
    ) => {
      const intervalMs = poll.intervalMs ?? 2000;
      const timeoutMs = poll.timeoutMs ?? 300_000;
      const started = Date.now();
      const client = createSchoolAiClient(options);
      while (Date.now() - started < timeoutMs) {
        const job = await client.getJob(jobId);
        if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
          return job;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      throw new SchoolAiClientError(`Timed out waiting for job ${jobId}`, 408, { jobId });
    },
  };
}

export const schoolAiClient = createSchoolAiClient();
