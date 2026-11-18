import type {ContextRef,DecisionsResponse,WorkDetailResponse,WorkspaceResponse} from '@renvarel/architect-core';

export type ExperienceFixtureEnvelope={
  project:{id:string;name:string};workflow:{id:string;name:string};pendingTotal:number;
  decisionIds:{approve:string;reject:string;requestRevision:string;stale:string;lastPending:string};
  workIds:{verified:string;verifiedControl:string;failed:string;checking:string;activePasses:string;failedCompletion:string;
    historical:string;stale:string;connectionCodex:string;connectionChatgpt:string;connectionAutomatic:string};
  itemIds:{implemented:string};
  stepIds:{verified:string;verifiedControl:string;failed:string;checking:string;historical:string;implemented:null};
  contexts:Record<string,ContextRef>;
  annotationOriginal:{text:string;materialJSON:string};
};
export type ExperienceCommand={kind:'snapshot'}|{kind:'resolve_pending_and_replace'}|{kind:'invalidate_source';workId:string};
export type ExperienceSnapshot={kind:'snapshot';fixture:ExperienceFixtureEnvelope;workspace:WorkspaceResponse;decisions:DecisionsResponse;work:WorkDetailResponse[]};
export type ExperienceCommandResult=ExperienceSnapshot|
  {kind:'resolve_pending_and_replace';removedDecisionId:string;replacementDecisionId:string;pendingTotal:number;viewDigest:string}|
  {kind:'invalidate_source';workId:string;workState:string;verification:string};
export type ExperienceIPCRequest={id:string;command:ExperienceCommand};
export type ExperienceIPCResponse={id:string;ok:true;result:ExperienceCommandResult}|{id:string;ok:false;error:string};
