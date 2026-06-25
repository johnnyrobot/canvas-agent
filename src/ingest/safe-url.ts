/**
 * SSRF guard for URL ingestion.
 *
 * `http_sources` lets docling-serve fetch a URL server-side. If a URL ever
 * reaches it unvalidated, a prompt-injected document (or a careless caller)
 * could point the fetch at the cloud-metadata endpoint (169.254.169.254), the
 * loopback Ollama daemon (127.0.0.1:11434), an RFC1918 host, or a `file://`
 * path — i.e. a classic SSRF. This module rejects those targets before the URL
 * is ever forwarded.
 *
 * Scope: this is a STATIC guard. It allowlists the scheme and denies literal
 * private/loopback/link-local/reserved IPs (including the integer/hex/octal/
 * shorthand encodings the WHATWG URL parser canonicalizes for us). It does NOT
 * resolve DNS — a public hostname that resolves to a private address
 * (DNS-rebinding) is out of scope here, because the actual fetch happens in the
 * out-of-process docling-serve sidecar and resolving in this process would not
 * bind the sidecar's later resolution (TOCTOU). A caller wiring this to a live
 * tool should additionally pin/resolve at fetch time in the sidecar.
 */
import { isIP } from 'node:net';

export class IngestUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Refusing to ingest URL "${redactUrlForError(url)}": ${reason}.`);
    this.name = 'IngestUrlError';
  }
}

/**
 * Reduce a URL to scheme + host for safe inclusion in an error message: drops
 * the path, the query string (which may carry signed tokens), and any embedded
 * credentials — none of which should reach logs or the UI. `host` retains the
 * port but never the userinfo.
 */
function redactUrlForError(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<invalid URL>';
  }
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Throw `IngestUrlError` unless `rawUrl` is an http(s) URL whose host is not a
 * private, loopback, link-local, or otherwise-reserved literal address. Returns
 * the parsed `URL` on success.
 */
export function assertSafeIngestUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new IngestUrlError(String(rawUrl), 'not a valid absolute URL');
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new IngestUrlError(rawUrl, `scheme "${url.protocol}" is not allowed (only http/https)`);
  }
  // Embedded credentials are an SSRF / credential-leak smell — reject outright.
  if (url.username || url.password) {
    throw new IngestUrlError(rawUrl, 'embedded credentials are not allowed');
  }
  if (isBlockedHost(url.hostname)) {
    throw new IngestUrlError(
      rawUrl,
      'host targets a private, loopback, link-local, or reserved address',
    );
  }
  return url;
}

function isBlockedHost(hostname: string): boolean {
  // `URL` brackets IPv6 literals; strip them for `isIP` / range checks.
  let host = hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // Strip trailing root-label dot(s) so a fully-qualified form ("localhost.",
  // "127.0.0.1.") can't slip past the loopback / literal-IP checks below.
  host = host.replace(/\.+$/, '');

  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;

  const version = isIP(host);
  if (version === 4) return isBlockedV4(host);
  if (version === 6) return isBlockedV6(lower);
  // A non-literal DNS name: cannot be classified statically (see module note on
  // DNS-rebinding scope). Allow — the scheme/credential checks still applied.
  return false;
}

function isBlockedV4(ip: string): boolean {
  const octets = ip.split('.').map((s) => Number(s));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed — fail closed
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isBlockedV6(ip: string): boolean {
  if (ip === '::1' || ip === '::') return true; // loopback / unspecified
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(ip)) return true; // fc00::/7 unique-local
  // IPv4-mapped/compatible — re-check the embedded v4, dotted or hextet form.
  const dotted = ip.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isBlockedV4(dotted[1]!);
  const hextets = ip.match(/::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hextets) {
    const hi = parseInt(hextets[1]!, 16);
    const lo = parseInt(hextets[2]!, 16);
    return isBlockedV4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
  }
  return false;
}
