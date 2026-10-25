import Link from "next/link";
import { notFound } from "next/navigation";
import { getCockpitContext } from "@/features/cockpit/load";
import { Panel, ToneBadge } from "@/components/cockpit/primitives";
import { loadNorthStarTree } from "@/core/north-star/tree";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCockpitContext();
  if (!ctx) return null;

  const { id } = await params;
  const tree = loadNorthStarTree();
  const node = tree.byId.get(id);
  if (!node) notFound();

  const path = tree.pathOf(id);
  const program = path.find((n) => n.type === "program");
  const visualPanelIds =
    node.visual_panels && node.visual_panels.length > 0
      ? node.visual_panels
      : node.type !== "program"
        ? (program?.visual_panels ?? [])
        : [];
  const visualPanelLabels = visualPanelIds.map(
    (panelId) => tree.seed.visual_map_panels[String(panelId)] ?? String(panelId),
  );
  const children = tree.childrenOf(id);

  return (
    <div>
      <nav className="cx-path">
        {path.map((ancestor, index) => (
          <span key={ancestor.id}>
            <Link href={index === 0 ? "/cockpit/north-star" : `/cockpit/north-star/${ancestor.id}`}>
              {ancestor.title}
            </Link>
            {index < path.length - 1 && " / "}
          </span>
        ))}
      </nav>

      <header className="cx-pagehead">
        <p className="cx-eyebrow cx-path__title">{node.type}</p>
        <h1>{node.title}</h1>
        <div>
          <span className="cx-chip">{node.type}</span>
          <span className="cx-chip">{node.priority}</span>
          <ToneBadge size="sm" tone="unknown" label={node.implementation_status} />
        </div>
      </header>

      <dl className="cx-kv">
        <dt>id</dt>
        <dd>{node.id}</dd>
        <dt>type</dt>
        <dd>{node.type}</dd>
        <dt>priority</dt>
        <dd>{node.priority}</dd>
        <dt>target_definition</dt>
        <dd>{node.target_definition}</dd>
        <dt>implementation_status</dt>
        <dd>{node.implementation_status}</dd>
        <dt>maturity</dt>
        <dd>—</dd>
        <dt>progress</dt>
        <dd>non calculé</dd>
        <dt>source</dt>
        <dd>{node.source}</dd>
        <dt>visual_panels</dt>
        <dd>{visualPanelLabels.length > 0 ? visualPanelLabels.join(", ") : "—"}</dd>
      </dl>

      <Panel title="Preuves">
        <p>Aucune preuve reliée — état NO_TELEMETRY (le lien Work OS arrive en tranche 2)</p>
      </Panel>

      <Panel title="Dépendances">
        <p>Non renseignées dans le seed v1</p>
      </Panel>

      <Panel title="Enfants">
        {children.length === 0 ? (
          <p className="cx-empty">Aucun</p>
        ) : (
          <ol className="cx-list">
            {children.map((child) => (
              <li key={child.id}>
                <Link href={`/cockpit/north-star/${child.id}`} className="cx-list__main">
                  {child.title}
                </Link>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
