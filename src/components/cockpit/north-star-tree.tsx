import Link from "next/link";
import { ToneBadge } from "@/components/cockpit/primitives";
import { evidenceStateOf } from "@/core/north-star/tree";
import type { NorthStarNode, NorthStarTree } from "@/core/north-star/tree";

function toneFor(status: string): "flow" | "ok" | "critical" | "autonomy" | "warn" | "unknown" {
  if (status === "UNVERIFIED" || status === "NO_TELEMETRY") return "unknown";
  if (status === "BLOCKED_EVIDENCED") return "warn";
  if (status === "IN_PROGRESS_EVIDENCED") return "flow";
  if (status.endsWith("_EVIDENCED")) return "ok";
  return "unknown";
}

export function visibleSetFor(tree: NorthStarTree, nodes: readonly NorthStarNode[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    for (const ancestor of tree.pathOf(node.id)) {
      ids.add(ancestor.id);
    }
  }
  return ids;
}

function CapabilityRow({ node }: { node: NorthStarNode }) {
  return (
    <Link href={`/cockpit/north-star/${node.id}`} className="cx-list__main">
      <span>{node.title}</span>
      <span className="cx-chip">{node.priority}</span>
      <ToneBadge size="sm" tone={toneFor(node.implementation_status)} label={node.implementation_status} />
      <span className="cx-badge cx-badge--sm">{evidenceStateOf(node)}</span>
    </Link>
  );
}

function ProjectDetails({
  tree,
  node,
  visible,
  openAll,
}: {
  tree: NorthStarTree;
  node: NorthStarNode;
  visible: ReadonlySet<string> | null;
  openAll: boolean;
}) {
  const children = tree.childrenOf(node.id).filter((child) => !visible || visible.has(child.id));
  return (
    <details className="ns-tree__project" open={openAll || undefined}>
      <summary>
        <span>{node.title}</span>
        <span className="cx-chip">{node.priority}</span>
        <ToneBadge size="sm" tone={toneFor(node.implementation_status)} label={node.implementation_status} />
        <span className="cx-badge cx-badge--sm">{children.length}</span>
      </summary>
      <ol className="cx-list">
        {children.map((child) => (
          <li key={child.id}>
            <CapabilityRow node={child} />
          </li>
        ))}
      </ol>
    </details>
  );
}

export function NorthStarTreeView({
  tree,
  programs,
  visible,
  openAll,
}: {
  tree: NorthStarTree;
  programs: readonly NorthStarNode[];
  visible: ReadonlySet<string> | null;
  openAll: boolean;
}) {
  const visiblePrograms = programs.filter((program) => !visible || visible.has(program.id));
  return (
    <ol className="cx-list ns-tree">
      {visiblePrograms.map((program) => {
        const projects = tree.childrenOf(program.id).filter((child) => !visible || visible.has(child.id));
        return (
          <li key={program.id} className="ns-tree__program">
            <details open={openAll || undefined}>
              <summary>
                <span>{program.title}</span>
                <ToneBadge size="sm" tone={toneFor(program.implementation_status)} label={program.implementation_status} />
                <span className="cx-chip">{program.priority}</span>
                <span className="cx-badge cx-badge--sm">{projects.length}</span>
              </summary>
              <ol className="cx-list">
                {projects.map((project) => (
                  <li key={project.id}>
                    <ProjectDetails tree={tree} node={project} visible={visible} openAll={openAll} />
                  </li>
                ))}
              </ol>
            </details>
          </li>
        );
      })}
    </ol>
  );
}
