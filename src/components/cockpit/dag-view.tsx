"use client";

import { Maximize2, Route, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { NODE_H, NODE_W, type DagModel, type DagNode } from "@/features/cockpit/dag";

import { NODE_TONE, nodeLabel } from "./node-tone";
import { ToneBadge } from "./primitives";

const PAD = 24;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Interactive mission DAG: zoom (wheel/buttons), pan (drag), keyboard-focusable
 * nodes, critical-path focus, inspector with dependencies and WHY evidence.
 * Renders only the graph ICOS returned — no layout invents nodes or edges.
 */
export function DagView({ dag, workerNames = {} }: { dag: DagModel; workerNames?: Record<string, string> }) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [view, setView] = useState({ x: PAD, y: PAD, k: 1 });
  const [selected, setSelected] = useState<string | null>(dag.criticalPath.at(-1) ?? null);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const byId = useMemo(() => new Map(dag.nodes.map((n) => [n.id, n])), [dag]);
  const vw = Math.max(640, dag.width + PAD * 2);
  const vh = Math.max(280, Math.min(640, dag.height + PAD * 2));

  const fit = () => {
    const k = clamp(Math.min((vw - PAD * 2) / dag.width, (vh - PAD * 2) / dag.height), 0.2, 1.5);
    setView({ x: PAD, y: PAD, k });
  };
  const zoom = (factor: number, cx = vw / 2, cy = vh / 2) =>
    setView((v) => {
      const k = clamp(v.k * factor, 0.2, 2.5);
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });

  // Wheel zoom needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, ((e.clientX - r.left) / r.width) * vw, ((e.clientY - r.top) / r.height) * vh);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vw, vh]);

  const scale = () => {
    const r = svg.current!.getBoundingClientRect();
    return vw / r.width;
  };
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) svg.current?.setPointerCapture(e.pointerId);
    d.moved = true;
    const s = scale();
    setView((v) => ({ ...v, x: v.x + dx * s, y: v.y + dy * s }));
    drag.current = { x: e.clientX, y: e.clientY, moved: true };
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const choose = (id: string) => {
    if (!drag.current?.moved) setSelected(id);
  };
  const onNodeKey = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelected(id);
    }
  };

  const critical = new Set(dag.criticalPath);
  const node = selected ? byId.get(selected) : undefined;
  const dim = (n: DagNode) => criticalOnly && !critical.has(n.id);

  const edges = useMemo(
    () =>
      dag.edges.map((e) => {
        const a = byId.get(e.from)!;
        const b = byId.get(e.to)!;
        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const mx = (x1 + x2) / 2;
        return { ...e, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` };
      }),
    [dag, byId],
  );

  if (dag.nodes.length === 0) {
    return <p className="cx-empty">This mission has no task graph yet.</p>;
  }

  return (
    <div className="cx-dag">
      <div className="cx-dag__stage">
        <div className="cx-dag__tools" role="toolbar" aria-label="Graph view">
          <button type="button" onClick={() => zoom(1.2)} aria-label="Zoom in">
            <ZoomIn size={16} aria-hidden />
          </button>
          <button type="button" onClick={() => zoom(1 / 1.2)} aria-label="Zoom out">
            <ZoomOut size={16} aria-hidden />
          </button>
          <button type="button" onClick={fit} aria-label="Fit graph">
            <Maximize2 size={16} aria-hidden />
          </button>
          <button type="button" onClick={() => setCriticalOnly((v) => !v)} aria-pressed={criticalOnly} disabled={!dag.criticalPath.length}>
            <Route size={16} aria-hidden /> Critical path
          </button>
          <span className="cx-dim">
            {dag.nodes.length} tasks · {dag.roots.length} parallel root{dag.roots.length === 1 ? "" : "s"} · max width {dag.maxParallelism} · remaining critical path {dag.criticalRemaining}
          </span>
        </div>

        <svg
          ref={svg}
          viewBox={`0 0 ${vw} ${vh}`}
          className="cx-dag__svg"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          role="group"
          aria-label="Mission task graph"
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {edges.map((e) => (
              <path
                key={`${e.from}-${e.to}`}
                d={e.d}
                className="cx-dag__edge"
                data-critical={e.critical || undefined}
                data-dim={(criticalOnly && !e.critical) || undefined}
                data-hot={selected === e.from || selected === e.to || undefined}
              />
            ))}
            {dag.nodes.map((n) => (
              <g
                key={n.id}
                transform={`translate(${n.x} ${n.y})`}
                data-tone={NODE_TONE[n.status]}
                className="cx-dag__node"
                data-critical={n.onCriticalPath || undefined}
                data-selected={selected === n.id || undefined}
                data-dim={dim(n) || undefined}
                tabIndex={0}
                role="button"
                aria-label={`${n.title}: ${nodeLabel(n.status)}${n.onCriticalPath ? ", on critical path" : ""}`}
                aria-pressed={selected === n.id}
                onClick={() => choose(n.id)}
                onKeyDown={(e) => onNodeKey(e, n.id)}
              >
                <rect width={NODE_W} height={NODE_H} rx={10} />
                <rect width={4} height={NODE_H - 16} x={8} y={8} rx={2} className="cx-dag__bar" />
                <text x={20} y={26} className="cx-dag__title">
                  {n.title.length > 26 ? `${n.title.slice(0, 25)}…` : n.title}
                </text>
                <text x={20} y={46} className="cx-dag__status">
                  {nodeLabel(n.status)}
                  {n.attempt ? ` · #${n.attempt.attempt}` : ""}
                </text>
              </g>
            ))}
          </g>
        </svg>
        {(dag.cycle.length > 0 || dag.danglingDependencies.length > 0) && (
          <p className="cx-warn-text" role="alert">
            Graph integrity: {dag.cycle.length} task(s) on a dependency cycle, {dag.danglingDependencies.length} dangling dependency id(s).
          </p>
        )}
      </div>

      <aside className="cx-inspector" aria-live="polite">
        {node ? <Inspector node={node} byId={byId} onSelect={setSelected} workerNames={workerNames} /> : <p className="cx-dim">Select a task to inspect it.</p>}
      </aside>
    </div>
  );
}

function Inspector({
  node,
  byId,
  onSelect,
  workerNames,
}: {
  node: DagNode;
  byId: Map<string, DagNode>;
  onSelect: (id: string) => void;
  workerNames: Record<string, string>;
}) {
  const link = (id: string) => {
    const n = byId.get(id);
    return (
      <li key={id}>
        {n ? (
          <button type="button" className="cx-linkbtn" onClick={() => onSelect(id)}>
            <ToneBadge tone={NODE_TONE[n.status]} label={nodeLabel(n.status)} size="sm" /> {n.title}
          </button>
        ) : (
          <span className="cx-missing" data-kind="unknown">
            UNKNOWN <code>{id}</code>
          </span>
        )}
      </li>
    );
  };
  const worker = node.attempt?.workerId;

  return (
    <>
      <p className="cx-eyebrow">Task</p>
      <h3>{node.title}</h3>
      <ToneBadge tone={NODE_TONE[node.status]} label={nodeLabel(node.status)} />
      {node.onCriticalPath && <span className="cx-chip">critical path</span>}

      <dl className="cx-kv">
        <dt>Canonical status</dt>
        <dd>
          <code>{node.canonicalStatus}</code>
        </dd>
        <dt>Capability</dt>
        <dd>{node.capability ?? "—"}</dd>
        <dt>Worker</dt>
        <dd>{worker ? (workerNames[worker] ?? <code>{worker}</code>) : (node.workerKind ?? "not assigned")}</dd>
        <dt>Attempt</dt>
        <dd>{node.attempt ? `#${node.attempt.attempt} · ${node.attempt.state}` : "no active attempt"}</dd>
        {node.attempt?.dispatchedAt && (
          <>
            <dt>Dispatched</dt>
            <dd>{new Date(node.attempt.dispatchedAt).toLocaleString("en-GB")}</dd>
          </>
        )}
        <dt>Review</dt>
        <dd>{node.review ? node.review.decision : "none recorded"}</dd>
        <dt>Integration</dt>
        <dd>
          <span className="cx-missing" data-kind="not_available">
            NOT AVAILABLE <span className="cx-missing__req">BR-14</span>
          </span>
        </dd>
      </dl>

      {node.blockedReason && (
        <p className="cx-blocked">
          <strong>Blocked:</strong> {node.blockedReason}
        </p>
      )}

      <h4>Depends on ({node.dependsOn.length})</h4>
      <ul className="cx-deps">{node.dependsOn.length ? node.dependsOn.map(link) : <li className="cx-dim">root task</li>}</ul>
      <h4>Unblocks ({node.dependents.length})</h4>
      <ul className="cx-deps">{node.dependents.length ? node.dependents.map(link) : <li className="cx-dim">leaf task</li>}</ul>

      <h4>WHY</h4>
      <ul className="cx-why">
        <li>
          <strong>Why this worker?</strong>{" "}
          <span className="cx-missing" data-kind="not_available">
            WHY DATA NOT AVAILABLE <span className="cx-missing__req">BR-09</span>
          </span>
        </li>
        {node.attempt?.failureClass || node.attempt?.lastError ? (
          <li>
            <strong>Why retry?</strong> {node.attempt.failureClass && <code>{node.attempt.failureClass}</code>} {node.attempt.lastError}
          </li>
        ) : null}
        {node.review && (
          <li>
            <strong>Why {node.review.decision}?</strong> {node.review.reasons.join(" · ")}
            <span className="cx-dim">
              {" "}
              — {node.review.reviewerKind} reviewer
              {node.review.provider ? ` · ${node.review.provider}/${node.review.model}` : ""}
            </span>
          </li>
        )}
        {node.blockedReason && (
          <li>
            <strong>Why blocked?</strong> {node.blockedReason}
          </li>
        )}
      </ul>
    </>
  );
}
