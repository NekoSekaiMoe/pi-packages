import type { CallHierarchyItem, Location } from "./lsp-types.ts";
import { uriToFilePath, type LspClient } from "./client.ts";

export type Direction = "incoming" | "outgoing" | "both";

interface GraphNode {
  item: CallHierarchyItem;
  children: GraphNode[];
  callSites: string[]; // file:line of call sites between parent and this node
  recursive: boolean;
}

const MAX_NODES = 80;

function itemKey(item: CallHierarchyItem): string {
  return `${item.uri}#${item.range.start.line}:${item.range.start.character}`;
}

function shortName(item: CallHierarchyItem): string {
  const file = uriToFilePath(item.uri);
  return `${file}:${item.selectionRange.start.line + 1}`;
}

function kindLabel(kind: number | undefined): string {
  switch (kind) {
    case 6: return "var";    // Variable
    case 8: return "field";
    case 12: return "fn";    // Function
    case 13: return "";      // Method (most common, keep short)
    case 23: return "ctor";  // Constructor
    default: return "";
  }
}

function siteLabel(locations: Location[] | undefined): string {
  const uri = locations?.[0]?.uri;
  if (!uri) return "";
  return `${uriToFilePath(uri)}:${locations![0].range.start.line + 1}`;
}

async function buildTree(
  client: LspClient,
  root: CallHierarchyItem,
  direction: "incoming" | "outgoing",
  depth: number,
): Promise<GraphNode> {
  const seen = new Set([itemKey(root)]);
  const rootNode: GraphNode = { item: root, children: [], callSites: [], recursive: false };

  const expand = async (node: GraphNode, currentDepth: number): Promise<void> => {
    if (currentDepth >= depth || seen.size >= MAX_NODES) return;
    const calls = (direction === "incoming" ? await client.incomingCalls(node.item) : await client.outgoingCalls(node.item)) as
      ({ from?: CallHierarchyItem; to?: CallHierarchyItem; fromRanges?: Location[] } | null)[] | null;
    for (const call of (calls ?? []).filter((c): c is NonNullable<typeof c> => c != null)) {
      const next = direction === "incoming" ? call.from : call.to;
      if (!next) continue;
      const key = itemKey(next);
      const recursive = key === itemKey(root);
      if (recursive) {
        node.children.push({ item: next, children: [], callSites: [siteLabel(call.fromRanges)], recursive: true });
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size >= MAX_NODES) return;
      const child: GraphNode = { item: next, children: [], callSites: [siteLabel(call.fromRanges)], recursive: false };
      node.children.push(child);
      await expand(child, currentDepth + 1);
    }
  };

  await expand(rootNode, 0);
  return rootNode;
}

function renderTree(node: GraphNode, direction: "incoming" | "outgoing", lines: string[] = [], indent = ""): string[] {
  const arrow = direction === "incoming" ? "←" : "→";
  node.children.forEach((child, index) => {
    const last = index === node.children.length - 1;
    const branch = indent === "" ? "  " : `${indent}${last ? "└─ " : "├─ "}`;
    const kind = kindLabel(child.item.kind);
    const name = `${child.item.name}${kind ? ` (${kind})` : ""}`;
    const mark = child.recursive ? "  ↻ recursive" : "";
    lines.push(`${branch}${arrow} ${name}  ${shortName(child.item)}${mark}`);
    if (!child.recursive) renderTree(child, direction, lines, indent === "" ? "  " : `${indent}${last ? "   " : "│  "}`);
  });
  return lines;
}

/** Builds and renders a call hierarchy report around `root`. */
export async function callGraphReport(
  client: LspClient,
  root: CallHierarchyItem,
  direction: Direction,
  depth: number,
): Promise<string> {
  const header = `Root: ${root.name}${root.detail ? ` — ${root.detail}` : ""}  (${shortName(root)})`;
  const out: string[] = [header];

  if (direction !== "outgoing") {
    const tree = await buildTree(client, root, "incoming", depth);
    out.push("", "Callers (who calls it):");
    const lines = renderTree(tree, "incoming");
    out.push(...(lines.length > 0 ? lines : ["  (none)"]));
  }
  if (direction !== "incoming") {
    const tree = await buildTree(client, root, "outgoing", depth);
    out.push("", "Callees (what it calls):");
    const lines = renderTree(tree, "outgoing");
    out.push(...(lines.length > 0 ? lines : ["  (none)"]));
  }
  return out.join("\n");
}
