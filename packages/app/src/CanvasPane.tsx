import '@xyflow/react/dist/style.css';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyEdgeChanges, applyNodeChanges, Background, Controls, Handle, MarkerType, Position, ReactFlow,
  type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import type { Diagnostic, Workflow } from '@reins/core';
import { KINDS } from './canvasKinds.js';
import { toGraph, type BoxData, type WireData } from './canvas.js';
import type { CanvasView } from './editorState.js';
import { layout } from './layout.js';
import { StepChips } from './StepChips.js';
import type { StepMap } from './stepStatus.js';

// Status comes through a context, not the graph: a streamed row must not rebuild the nodes mid-drag.
export const StatusCtx = createContext<{ status: StepMap; show: boolean }>({ status: {}, show: false });

export const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

function StepBox({ data, selected }: NodeProps<Node<BoxData>>) {
  const { status, show } = useContext(StatusCtx);
  const { step, cond, mark } = data;
  const k = KINDS[step.kind];
  const info = show ? status[step.id] : undefined;
  return (
    <div className={cx('cbox', selected && 'selected', info?.state, mark && `mark-${mark}`)}>
      <Handle type="target" position={Position.Top} id="in" />
      <div className="ckind">{step.kind}</div>
      <div className={cx('csub', step.kind === 'run' && 'mono')}>{k.sub(step, cond)}</div>
      {info && <div className="cchips"><StepChips i={info} /></div>}
      <Handle type="source" position={Position.Bottom} id="next" />
      {k.fails && <Handle type="source" position={Position.Right} id="on-fail" className="hfail" title="on fail" />}
    </div>
  );
}

function GroupBox({ data, selected }: NodeProps<Node<BoxData>>) {
  const { status, show } = useContext(StatusCtx);
  const { step, cond, mark, elseX } = data;
  const info = show ? status[step.id] : undefined;
  return (
    <div className={cx('cbox cgroup', selected && 'selected', info?.state, mark && `mark-${mark}`)}>
      <Handle type="target" position={Position.Top} id="in" />
      <div className="chead2"><span className="ckind">{step.kind}</span> {KINDS[step.kind].sub(step, cond)}{info && <StepChips i={info} />}</div>
      {elseX !== undefined && <div className="celse" style={{ left: elseX - 14 }}><span>else</span></div>}
      <Handle type="source" position={Position.Bottom} id="next" />
    </div>
  );
}

const nodeTypes = { step: StepBox, group: GroupBox };

// Marker colours are attributes, not CSS: they cannot use the theme variables.
const WIRES = {
  next: { cls: 'w-next', color: '#a3a19b', label: undefined },
  'on-fail': { cls: 'w-fail', color: '#e05d5a', label: 'on fail' },
  order: { cls: 'w-order', color: undefined, label: undefined },
  old: { cls: 'w-old', color: '#6f6e6b', label: undefined },
} as const;

function styleWire(e: Edge<WireData>): Edge<WireData> {
  const kind = e.data!.kind;
  const w = WIRES[kind === 'next' || kind === 'on-fail' || kind === 'order' ? kind : 'old'];
  return {
    ...e,
    className: cx(w.cls, e.data!.mark && `mark-${e.data!.mark}`),
    label: w.label ?? (w === WIRES.old ? kind : undefined),
    ...(w.color ? { markerEnd: { type: MarkerType.ArrowClosed, color: e.data!.mark === 'error' ? '#e05d5a' : w.color } } : {}),
  };
}

export function Canvas({ w, steps, diags, text, selected, view, onView, onSelect }: {
  w: Workflow; steps: Array<{ id: string; cond?: string }>; diags: Diagnostic[]; text: string; selected?: string;
  view: CanvasView; onView: (patch: CanvasView) => void; onSelect: (id: string | undefined) => void;
}) {
  const boxes = useMemo(() => layout(w.steps), [w]);
  const derived = useMemo(() => {
    const conds = Object.fromEntries(steps.flatMap((s) => (s.cond === undefined ? [] : [[s.id, s.cond]])));
    const g = toGraph(w, boxes, { conds, diags, text, selected });
    return { nodes: g.nodes, edges: g.edges.map(styleWire) };
  }, [w, boxes, steps, diags, text, selected]);
  const [nodes, setNodes] = useState<Node<BoxData>[]>(derived.nodes);
  const [edges, setEdges] = useState<Edge<WireData>[]>(derived.edges);
  useEffect(() => { setNodes(derived.nodes); setEdges(derived.edges); }, [derived]);

  // With no saved viewport, fitView fires onMoveEnd on mount; that is not a user pan.
  const skipMove = useRef(!view.view);

  return (
    <ReactFlow
      colorMode="dark" nodeTypes={nodeTypes} nodes={nodes} edges={edges}
      onNodesChange={(c: NodeChange<Node<BoxData>>[]) => setNodes((ns) => applyNodeChanges(c, ns))}
      onEdgesChange={(c: EdgeChange<Edge<WireData>>[]) => setEdges((es) => applyEdgeChanges(c, es))}
      deleteKeyCode={null} nodesDraggable={false} nodesConnectable={false} edgesFocusable={false}
      onMoveEnd={(_, vp) => { if (skipMove.current) skipMove.current = false; else onView({ view: vp }); }}
      onNodeClick={(_, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(undefined)}
      {...(view.view ? { defaultViewport: view.view } : { fitView: true })}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
