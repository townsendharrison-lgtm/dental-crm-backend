export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'metadata.google.internal',
]);

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;

  // IPv4 private / link-local / loopback
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  // Basic IPv6 local prefixes
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;

  return false;
}

function cleanUrlCandidate(raw: string): string | null {
  let cleaned = raw.replace(/[),.;!?]+$/g, '');
  try {
    const u = new URL(cleaned);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isPrivateHostname(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** First safe http(s) URL found in message text. */
export function extractFirstUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const matches = text.match(URL_RE);
  if (!matches) return null;
  for (const m of matches) {
    const cleaned = cleanUrlCandidate(m);
    if (cleaned) return cleaned;
  }
  return null;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)));
}

function metaContent(html: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
      'i',
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeHtmlEntities(m[1].trim());
  }
  return undefined;
}

function absoluteUrl(base: string, maybeRelative?: string): string | undefined {
  if (!maybeRelative) return undefined;
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return undefined;
  }
}

/**
 * Fetch Open Graph / basic meta for a URL. Best-effort; never throws.
 */
export async function fetchLinkPreview(
  rawUrl: string,
  timeoutMs = 3500,
): Promise<LinkPreview | null> {
  const url = cleanUrlCandidate(rawUrl);
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'DentalCRM-LinkPreview/1.0 (+https://localhost)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!res.ok) {
      return { url, title: new URL(url).hostname };
    }

    const finalUrl = res.url || url;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      // Direct image or non-HTML — still return a minimal card
      if (contentType.startsWith('image/')) {
        return { url: finalUrl, title: new URL(finalUrl).hostname, image: finalUrl };
      }
      return { url: finalUrl, title: new URL(finalUrl).hostname };
    }

    const html = (await res.text()).slice(0, 250_000);
    const title =
      metaContent(html, 'og:title') ||
      metaContent(html, 'twitter:title') ||
      (() => {
        const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        return m?.[1] ? decodeHtmlEntities(m[1].trim()) : undefined;
      })();

    const description =
      metaContent(html, 'og:description') ||
      metaContent(html, 'twitter:description') ||
      metaContent(html, 'description');

    const image = absoluteUrl(
      finalUrl,
      metaContent(html, 'og:image') || metaContent(html, 'twitter:image'),
    );

    const siteName = metaContent(html, 'og:site_name') || new URL(finalUrl).hostname;

    const favicon =
      absoluteUrl(
        finalUrl,
        (() => {
          const m = html.match(
            /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i,
          );
          return m?.[1];
        })(),
      ) || absoluteUrl(finalUrl, '/favicon.ico');

    return {
      url: finalUrl,
      title: title || siteName,
      description: description?.slice(0, 280),
      image,
      siteName,
      favicon,
    };
  } catch (err) {
    console.warn('Link preview fetch failed:', url, (err as Error)?.message);
    try {
      return { url, title: new URL(url).hostname };
    } catch {
      return null;
    }
  } finally {
    clearTimeout(timer);
  }
}
