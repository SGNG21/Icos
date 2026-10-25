import Link from "next/link";
import { getCockpitContext } from "@/features/cockpit/load";
import { Panel } from "@/components/cockpit/primitives";
import { NorthStarTreeView, visibleSetFor } from "@/components/cockpit/north-star-tree";
import {
  loadNorthStarTree,
  searchNorthStar,
  filterNorthStar,
  nextActions,
} from "@/core/north-star/tree";
import type { NorthStarNode, NorthStarPriority } from "@/core/north-star/tree";

export const metadata = { title: "North Star" };

function isPriority(value: string | undefined): value is NorthStarPriority {
  return value === "P0" || value === "P1" || value === "P2";
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; priority?: string; program?: string }>;
}) {
  const ctx = await getCockpitContext();
  if (!ctx) return null;

  const tree = loadNorthStarTree();
  const params = await searchParams;

  const q = params.q?.trim() ?? "";
  const priority = isPriority(params.priority) ? params.priority : undefined;
  const programs = tree.childrenOf(tree.root.id);
  const programIds = new Set(programs.map((p) => p.id));
  const program = params.program && programIds.has(params.program) ? params.program : undefined;

  const matches: readonly NorthStarNode[] = q ? searchNorthStar(tree, q) : tree.seed.nodes;
  let result: readonly NorthStarNode[] = matches;
  if (priority || program) {
    const filtered = filterNorthStar(tree, { priority, programId: program });
    const filteredIds = new Set(filtered.map((n) => n.id));
    result = matches.filter((n) => filteredIds.has(n.id));
  }

  const hasFilter = Boolean(q || priority || program);
  const visible = hasFilter ? visibleSetFor(tree, result) : null;
  const openAll = visible !== null;

  function filterHref(priorityValue?: string) {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (priorityValue) sp.set("priority", priorityValue);
    const qs = sp.toString();
    return `/cockpit/north-star${qs ? `?${qs}` : ""}`;
  }

  return (
    <div>
      <header className="cx-pagehead">
        <p className="cx-eyebrow">North Star</p>
        <h1>ICOS ULTIMATE — North Star</h1>
        <p>
          Cible documentaire — pas un audit. Tous les états proviennent du seed {tree.seed.schema_version}{" "}
          ({tree.seed.dataset_id}) et restent UNVERIFIED tant qu&apos;aucune preuve Work OS n&apos;est
          reliée.
        </p>
      </header>

      <div className="cx-banner">{tree.seed.authority_warning}</div>

      <form method="GET" action="/cockpit/north-star">
        <input type="text" name="q" defaultValue={q} placeholder="Rechercher…" />
        <select name="priority" defaultValue={priority ?? ""}>
          <option value="">Toutes priorités</option>
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
        </select>
        <select name="program" defaultValue={program ?? ""}>
          <option value="">Tous programmes</option>
          {programs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <button type="submit">Filtrer</button>
      </form>

      <nav className="cx-filters">
        <Link href={filterHref()} aria-current={priority ? undefined : "page"}>
          Tout
        </Link>
        <Link href={filterHref("P0")} aria-current={priority === "P0" ? "page" : undefined}>
          P0
        </Link>
        <Link href={filterHref("P1")} aria-current={priority === "P1" ? "page" : undefined}>
          P1
        </Link>
        <Link href={filterHref("P2")} aria-current={priority === "P2" ? "page" : undefined}>
          P2
        </Link>
      </nav>

      <div className="cx-metrics">
        <div className="cx-metric">
          <span className="cx-metric__label">Programmes</span>
          <span className="cx-metric__value">{tree.counts.program}</span>
        </div>
        <div className="cx-metric">
          <span className="cx-metric__label">Projets</span>
          <span className="cx-metric__value">{tree.counts.project}</span>
        </div>
        <div className="cx-metric">
          <span className="cx-metric__label">Capacités</span>
          <span className="cx-metric__value">{tree.counts.capability}</span>
        </div>
        <div className="cx-metric">
          <span className="cx-metric__label">UNVERIFIED</span>
          <span className="cx-metric__value">{tree.countsByStatus.UNVERIFIED}</span>
        </div>
        <div className="cx-metric">
          <span className="cx-metric__label">Résultats</span>
          <span className="cx-metric__value">{result.length}</span>
        </div>
      </div>

      <Panel title="Prochaines actions (cible seed)" eyebrow="focus_first">
        <ol className="cx-list">
          {nextActions(tree).map((node) => (
            <li key={node.id}>
              <Link href={`/cockpit/north-star/${node.id}`} className="cx-list__main">
                {node.title}
              </Link>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title="Arborescence">
        {result.length === 0 ? (
          <p className="cx-empty">Aucun nœud ne correspond.</p>
        ) : (
          <NorthStarTreeView tree={tree} programs={programs} visible={visible} openAll={openAll} />
        )}
      </Panel>
    </div>
  );
}
