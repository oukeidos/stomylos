import { isFlatMemory, type StoredMemoryDocument, type FlatMemoryDocument } from '../src/shared/memory';
export function flat(doc: StoredMemoryDocument | null | undefined): FlatMemoryDocument {
  if (!doc || !isFlatMemory(doc)) throw new Error('expected_flat_memory');
  return doc;
}
/** Keep fixture intent readable while emitting the actual v7 wire shape. */
export function splitDelta(patch: {operations: {op:string;id:string|null;category?:string|null;text:string|null;source_message_ids:string[]}[]}): string {
  return JSON.stringify({
    add: patch.operations.filter(o=>o.op==='add').map(({text,source_message_ids})=>({text,source_message_ids})),
    update: patch.operations.filter(o=>o.op==='update').map(({id,text,source_message_ids})=>({id,text,source_message_ids})),
    delete: patch.operations.filter(o=>o.op==='delete').map(({id,source_message_ids})=>({id,source_message_ids}))
  });
}
