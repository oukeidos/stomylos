import { parentPort, workerData } from 'node:worker_threads';
import { Store, type StoreMethod } from './database';
import { failureCode } from './errors';
const methods: StoreMethod[] = ['explainPrepare', 'explainList', 'explainGet', 'explainStart', 'explainFinish', 'advanceStarter', 'intentionJobs', 'intentionJob', 'dispatchIntention', 'receiveIntention', 'acceptIntention', 'failIntention', 'retryIntentions', 'patternRelated', 'patternPreview', 'patternCreate', 'patternAttempt', 'patternDispatch', 'patternRetry', 'patternSave', 'patternFinish', 'patternList', 'patternDetail', 'patternHtml', 'patternAffected', 'patternDelete', 'sessions', 'sessionPage', 'unfinished', 'session', 'messages', 'requests', 'request', 'units', 'view',
  'createSession', 'searchMode', 'searchView', 'searchPrepare', 'searchDispatch', 'searchFinish', 'setOpening', 'setSessionBookmark', 'deleteSession', 'pendingDeletions', 'deletionAssets', 'finishDeletion', 'replaceQuestion', 'saveDraft', 'selectManual', 'changePartner', 'preparePartner', 'finishPartnerRoute', 'submit', 'commitRoute', 'createRequest', 'prepareChat', 'chatBody',
  'dispatch', 'prepareReply', 'checkpoint', 'finishRequest', 'finishReply', 'failRequest', 'end', 'saveAnalysis', 'integrity', 'starterInventory', 'starterJob', 'starterAttempt', 'starterAttempts', 'retryStarter', 'dispatchStarter', 'saveStarter', 'failStarter',
  'currentMemory', 'freezeMemory', 'memoryJob', 'memoryReady', 'retryMemory', 'skipMemory', 'prepareMemory', 'dispatchMemory', 'saveMemory', 'failMemory', 'close'];
try {
  const store = new Store(workerData.directory, workerData.nativePath, undefined, undefined, workerData.externallyLocked);
  parentPort!.postMessage({ type: 'ready' });
  parentPort!.on('message', ({ id, method, args }: { id: number; method: StoreMethod; args: any[] }) => {
    try {
      if (!methods.includes(method)) throw new Error('Invalid database operation');
      const value = (store[method] as (...args: any[]) => any).apply(store, args);
      parentPort!.postMessage({ id, value });
      if (method === 'close') parentPort!.close();
    } catch (error) { parentPort!.postMessage({ id, error: failureCode(error) }); }
  });
} catch (error) { parentPort!.postMessage({ type: 'startup-error', error: failureCode(error) }); parentPort!.close(); }
