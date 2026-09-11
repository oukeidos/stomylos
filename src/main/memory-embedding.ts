import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import manifest from './memory-embedding-manifest.json';
import { coldHash } from './cold-memory-store';
import { decodeVector, encodeVector, normalized } from './memory-vectors';
import { AppFailure } from './errors';

export const embeddingManifest = manifest;
export const embeddingManifestJson = JSON.stringify(manifest);
export const embeddingSpaceId = coldHash(embeddingManifestJson);
export function embeddingInput(text: string): string { return text.normalize('NFC').replace(/\s+/gu, ' ').trim(); }
export function tokenWindows(tokens: readonly number[], window = 510, overlap = 64) {
  if (!tokens.length || window <= overlap || overlap < 0) throw new AppFailure('cold_embedding_tokens');
  const result: { tokens: number[]; newTokens: number }[] = [];
  let covered = 0;
  for (let start = 0; start < tokens.length; start += window - overlap) {
    const end = Math.min(tokens.length, start + window);
    result.push({ tokens: tokens.slice(start, end), newTokens: end - covered }); covered = end;
    if (end === tokens.length) break;
  }
  return result;
}
export async function verifyEmbeddingAssets(directory: string) {
  for (const entry of manifest.files) {
    const path = join(directory, entry.path);
    let stat;
    try { stat = await lstat(path); } catch { throw new AppFailure('cold_model_missing'); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes) throw new AppFailure('cold_model_integrity');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    if (digest.digest('hex') !== entry.sha256) throw new AppFailure('cold_model_integrity');
  }
}

/** Instantiated exclusively in the supervised utility process. */
export async function loadEmbedding(directory: string) {
  await verifyEmbeddingAssets(directory);
  const { env, AutoTokenizer, AutoModel, Tensor } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFSCache = false;
  const tokenizer = await AutoTokenizer.from_pretrained(directory, { local_files_only: true });
  const model = await AutoModel.from_pretrained(directory, {
    local_files_only: true, dtype: 'q8', device: 'cpu',
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1, executionMode: 'sequential',
      extra: { session: { 'intra_op.allow_spinning': '0', 'inter_op.allow_spinning': '0' } } }
  });
  const special = tokenizer.encode('', { add_special_tokens: true });
  if (special.length !== 2 || special[0] !== tokenizer.convert_tokens_to_ids('[CLS]') || special[1] !== tokenizer.sep_token_id) {
    await model.dispose(); throw new AppFailure('cold_tokenizer_contract');
  }
  return {
    async embed(text: string) {
      const input = embeddingInput(text);
      const tokens = tokenizer.encode(input, { add_special_tokens: false });
      const windows = tokenWindows(tokens, manifest.window.contentTokens, manifest.window.overlap);
      const sum = new Float64Array(manifest.dimensions);
      for (const window of windows) {
        const ids = [special[0], ...window.tokens, special[1]], shape = [1, ids.length];
        const result = await model({
          input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), shape),
          attention_mask: new Tensor('int64', new BigInt64Array(ids.length).fill(1n), shape),
          token_type_ids: new Tensor('int64', new BigInt64Array(ids.length), shape)
        });
        const hidden = result.last_hidden_state;
        if (!hidden || hidden.dims.length !== 3 || hidden.dims[0] !== 1 || hidden.dims[1] !== ids.length || hidden.dims[2] !== manifest.dimensions) throw new AppFailure('cold_model_output');
        const cls = normalized(Array.from(hidden.data.slice(0, manifest.dimensions), Number));
        for (let i = 0; i < sum.length; i++) sum[i] += cls[i] * window.newTokens;
      }
      const vector = normalized(sum);
      decodeVector(encodeVector(vector), manifest.dimensions);
      return { vector: Array.from(vector), inputHash: coldHash(input), chunkCount: windows.length };
    },
    async close() { await model.dispose(); }
  };
}
