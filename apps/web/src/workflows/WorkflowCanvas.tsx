import {useCallback,useEffect,useMemo,useState,type ReactElement} from 'react';
import {ReactFlow,Background,Controls,MiniMap,Handle,Position,MarkerType,useUpdateNodeInternals,type NodeProps,type Node,type Viewport,type Edge,type OnNodesChange} from '@xyflow/react';
import type {Step, StepVerification, Workflow, WorkflowLayout} from '@renvarel/architect-core';
import {WorkflowList,verificationLabel} from './WorkflowList';

type FlowData = Record<string,unknown> & {
  title:string;purpose:string;kind:Step['kind'];selected:boolean;verification:StepVerification['verification'];
  returnSource:boolean;returnTarget:boolean;
};
function WorkflowNode({id,data}:NodeProps<Node<FlowData>>):ReactElement {
  const updateNodeInternals=useUpdateNodeInternals();
  useEffect(()=>{
    // Same-size layout refreshes can change handles without triggering a resize.
    updateNodeInternals(id);
  },[id,data.returnSource,data.returnTarget,updateNodeInternals]);
  return <div className={`step-node ${data.selected?'step-node-active':''}`}>
    <Handle type="target" position={Position.Left} isConnectable={false}/>
    <div className="node-kicker">{data.kind}</div><div className="node-title">{data.title}</div>
    <div className="node-description">{data.purpose}</div>
    <div className="verification-badge">{verificationLabel(data.verification)}</div>
    <Handle type="source" position={Position.Right} isConnectable={false}/>
    {data.returnSource&&<Handle id="return-source" type="source" position={Position.Bottom} isConnectable={false}/>}
    {data.returnTarget&&<Handle id="return-target" type="target" position={Position.Bottom} isConnectable={false}/>}
  </div>;
}
const nodeTypes = {workflow:WorkflowNode};
export function WorkflowCanvas({workflow,layout,verification,selected,viewport,list,mobile,onSelect,onViewport}:{
  workflow:Workflow; layout:WorkflowLayout; verification:StepVerification[]; selected:string;
  viewport?:Viewport; list:boolean; mobile:boolean; onSelect:(id:string)=>void; onViewport:(viewport:Viewport)=>void;
}):ReactElement {
  const [measured,setMeasured]=useState<Record<string,{width:number;height:number}>>({});
  const onNodesChange=useCallback<OnNodesChange<Node<FlowData>>>((changes)=>{
    setMeasured(previous=>{
      let next=previous;
      for(const change of changes){
        if(change.type!=='dimensions'||!change.dimensions)continue;
        const {width,height}=change.dimensions;
        if(width<=0||height<=0||(next[change.id]?.width===width&&next[change.id]?.height===height))continue;
        if(next===previous)next={...previous};
        next[change.id]={width,height};
      }
      return next;
    });
  },[]);
  const positions=useMemo(()=>new Map(workflow.steps.map(step=>[
    step.id,layout.positions.find(position=>position.stepId===step.id)??step.position,
  ])),[workflow,layout]);
  const returnEdges=useMemo(()=>new Set(workflow.connections.filter(edge=>{
    const source=positions.get(edge.source),target=positions.get(edge.target);
    if(!source||!target)return false;
    if(source.x!==target.x)return source.x>target.x;
    if(source.y!==target.y)return source.y>target.y;
    return edge.source>edge.target&&workflow.connections.some(other=>other.source===edge.target&&other.target===edge.source);
  }).map(edge=>edge.id)),[workflow,positions]);
  const returnHandles=useMemo(()=>{
    const sources=new Set<string>(),targets=new Set<string>();
    for(const edge of workflow.connections)if(returnEdges.has(edge.id)){sources.add(edge.source);targets.add(edge.target);}
    return {sources,targets};
  },[workflow,returnEdges]);
  const nodes = useMemo<Node<FlowData>[]>(()=>workflow.steps.map(step=>({
    id:step.id,type:'workflow',position:positions.get(step.id)??step.position,measured:measured[step.id],
    data:{title:step.title,purpose:step.purpose,kind:step.kind,selected:step.id===selected,
      verification:verification.find(value=>value.stepId===step.id)?.verification ?? 'not_checked',
      returnSource:returnHandles.sources.has(step.id),returnTarget:returnHandles.targets.has(step.id)},
  })),[workflow,positions,selected,verification,returnHandles,measured]);
  const edges = useMemo<Edge[]>(()=>workflow.connections.map(edge=>({...edge,animated:false,
    ...(returnEdges.has(edge.id)?{type:'smoothstep',sourceHandle:'return-source',targetHandle:'return-target',pathOptions:{offset:42,borderRadius:12}}:{}),
    style:{stroke:'#8296b1',strokeWidth:1.8},markerEnd:{type:MarkerType.ArrowClosed,color:'#8296b1'},label:edge.label,
  })),[workflow,returnEdges]);
  if (list || mobile) return <WorkflowList workflow={workflow} selected={selected} verification={verification} onSelect={onSelect}/>;
  return <div className="flow-frame" aria-label="Workflow graph">
    <ReactFlow key={workflow.id} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onNodeClick={(_event,node)=>onSelect(node.id)}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} fitView={!viewport}
      defaultViewport={viewport} fitViewOptions={{padding:0.25}} onMoveEnd={(_event,value)=>onViewport(value)}
      minZoom={0.25} maxZoom={2} colorMode="dark">
      <Background color="#2e3749" size={2} gap={22}/><Controls showInteractive={false}/>
      <MiniMap nodeColor={node=>node.data.selected?'#e4b867':'#748eae'} maskColor="rgba(7,11,17,.76)" zoomable pannable/>
    </ReactFlow>
  </div>;
}
