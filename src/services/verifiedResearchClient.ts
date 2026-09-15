/** Both CRM prediction surfaces use the same verified Python pipeline. */
export async function verifiedResearchRequest(path: string, body: unknown, authorization?: string) {
  const base = process.env.AI_SERVER_URL || 'http://localhost:8000';
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
  });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(result.detail || 'Verified research service unavailable');
  return result;
}
