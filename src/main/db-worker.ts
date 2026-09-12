import { parentPort, workerData } from 'node:worker_threads';
import { Store, type StoreMethod } from './database';
import { AppFailure, failureCode } from './errors';
const methods: StoreMethod[] = ['coldInitialize','coldTick','coldClaim','coldComplete','coldFail','coldRelease','coldIndexFailure','coldPage','coldDelete','coldRetry','coldStatus','associativeTick','associativeClaim','associativeComplete','associativeRelease','associativeFail','associativePending','associativeSelection','associativeForMessage','associativeAssertNotRevoked', 'retryMemoryAdd','skipMemoryAdd','memoryAddReady','prepareMemoryAdd','dispatchMemoryAdd','receiveMemoryAdd','acceptMemoryAdd','failMemoryAdd','prepareProvider', 'resumeEndResponse', 'endStatus', 'endBlocker', 'endBlockers', 'assertEndActive', 'takeAutomaticRetry', 'suppressAutomaticRetry', 'receiveEndResponse', 'endResponse', 'clearEndResponse', 'cancelEnd', 'memoryCandidate', 'cleanupAttempts', 'prepareCleanup', 'dispatchCleanup', 'receiveCleanup', 'acceptCleanup', 'failCleanup', 'patternRelated', 'patternPreview', 'patternCreate', 'patternAttempt', 'patternDispatch', 'patternRetry', 'patternSave', 'patternFinish', 'patternList', 'patternDetail', 'patternHtml', 'patternAffected', 'patternDelete', 'sessions', 'sessionPage', 'unfinished', 'session', 'messages', 'requests', 'request', 'units', 'view',
  'createSession', 'searchMode', 'searchView', 'searchPrepare', 'searchDispatch', 'searchFinish', 'setOpening', 'setReplyContext', 'setSessionBookmark', 'deleteSession', 'pendingDeletions', 'deletionAssets', 'finishDeletion', 'replaceQuestion', 'saveDraft', 'selectManual', 'changePartner', 'preparePartner', 'finishPartnerRoute', 'prepareRouterRecovery', 'finishRecoveryRoute', 'submit', 'commitRoute', 'createRequest', 'prepareChat', 'chatBody',
  'dispatch', 'prepareReply', 'checkpoint', 'finishRequest', 'finishReply', 'failRequest', 'end', 'saveAnalysis', 'integrity', 'starterInventory', 'starterJob', 'starterAttempt', 'starterAttempts', 'retryStarter', 'dispatchStarter', 'saveStarter', 'failStarter','admitAssociativeMemory',
  'startChat', 'memoryPreference', 'setMemoryPreference', 'memoryManagement', 'prepareMemoryEdit', 'commitMemoryEdit', 'currentMemory', 'freezeMemory', 'memoryJob', 'memoryReady', 'retryMemory', 'skipMemory', 'prepareMemory', 'dispatchMemory', 'saveMemory', 'failMemory', 'close'];
try {
  const store = new Store(workerData.directory, workerData.nativePath, undefined, undefined, workerData.externallyLocked);
  parentPort!.postMessage({ type: 'ready' });
  parentPort!.on('message', ({ id, method, args }: { id: number; method: StoreMethod; args: any[] }) => {
    try {
      if (!methods.includes(method)) throw new AppFailure('database_operation_unsupported');
      const value = (store[method] as (...args: any[]) => any).apply(store, args);
      parentPort!.postMessage({ id, value });
      if (method === 'close') parentPort!.close();
    } catch (error) { parentPort!.postMessage({ id, error: failureCode(error) }); }
  });
} catch (error) { parentPort!.postMessage({ type: 'startup-error', error: failureCode(error) }); parentPort!.close(); }
