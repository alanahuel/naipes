/**
 * GET /api/vault[?root=/abs/path] — the Obsidian connection's overview for
 * Settings → Obsidian: the vault's folder tree (two levels, with note
 * counts) and the live sync status. `root` previews another vault path
 * before it is saved.
 */
import { vaultOverview } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
	const root = new URL(request.url).searchParams.get("root") ?? undefined;
	if (root !== undefined && root !== "" && !root.startsWith("/")) {
		return Response.json({ error: "root must be an absolute path" }, { status: 400 });
	}
	return Response.json(vaultOverview(root || undefined));
}
