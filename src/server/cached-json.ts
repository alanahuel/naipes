/**
 * A cached JSON body as a response (perf, owner 2026-11-10): 304 when the
 * client already holds this exact version (If-None-Match), else the body
 * with its ETag. `no-cache` = the browser may keep it but must revalidate.
 */
export function cachedJson(request: Request, cached: { etag: string; body: string }): Response {
	const headers = { ETag: cached.etag, "Cache-Control": "no-cache" };
	if (request.headers.get("if-none-match") === cached.etag) return new Response(null, { status: 304, headers });
	return new Response(cached.body, { headers: { ...headers, "Content-Type": "application/json" } });
}
