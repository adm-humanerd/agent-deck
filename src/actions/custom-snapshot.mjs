import {validateDeckLayouts} from '../deck/deck-layout.mjs';
import {validateAction} from '../host/host-actions.mjs';
import {assetIdValid} from './deck-assets.mjs';

export const SNAPSHOT_VERSION=1;
export function validateCustomSnapshot(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='actions,assets,layouts,revision,schemaVersion'||input.schemaVersion!==SNAPSHOT_VERSION||!Number.isSafeInteger(input.revision)||input.revision<0)throw Error('잘못된 스냅샷 버전 또는 revision입니다.');
 const layouts=validateDeckLayouts(input.layouts);
 if(!Array.isArray(input.actions)||input.actions.length>128||!Array.isArray(input.assets)||input.assets.length>1024||new Set(input.assets).size!==input.assets.length||input.assets.some(id=>!assetIdValid(id)))throw Error('잘못된 동작/이미지 목록입니다.');
 const ids=new Set();
 const actions=input.actions.map(action=>{
  if(!action||typeof action!=='object'||Object.keys(action).sort().join(',')!=='definition,enabled,id'||typeof action.id!=='string'||!/^[-a-zA-Z0-9_]{1,64}$/.test(action.id)||ids.has(action.id)||typeof action.enabled!=='boolean')throw Error('잘못된 동작 등록입니다.');
  ids.add(action.id);return {id:action.id,enabled:action.enabled,definition:validateAction(action.definition)};
 });
 for(const page of layouts)for(const slot of page.slots){
  if(slot.type==='custom'&&!ids.has(slot.actionId))throw Error('키가 참조하는 동작이 없습니다.');
  if(slot.presentation?.asset&&!input.assets.includes(slot.presentation.asset))throw Error('키가 참조하는 이미지가 없습니다.');
 }
 return {schemaVersion:SNAPSHOT_VERSION,revision:input.revision,layouts,actions,assets:[...input.assets]};
}
export function projectSnapshot(snapshot,local){
 const {schemaVersion,revision,initialized,layouts,assets,actions}=snapshot;
 return {schemaVersion,revision,initialized,layouts,assets,actions:local?actions:actions.map(({id,enabled})=>({id,enabled}))};
}
