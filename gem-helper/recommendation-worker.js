// Gem helper calculation worker (module worker). One engine with one target cache per worker.
//   request: {type:'recommend', requestId, generation, input:{modelVersion, target, state, offer}}
//   result:  {type:'result', requestId, generation, result}
// A request from an older generation than one already seen is answered as cancelled. A long synchronous
// calculation is cancelled by terminating the worker.
import { cancelledGemRecommendation, createGemRecommendationEngine } from './engine/arkgrid-gem-recommendation.js';

const engine = createGemRecommendationEngine();
let newestGeneration = null;

self.addEventListener('message', event => {
  const message = event.data;
  if (!message || typeof message !== 'object' || message.type !== 'recommend'
    || !Number.isSafeInteger(message.requestId) || !Number.isSafeInteger(message.generation)) return;
  const { requestId, generation } = message;
  if (newestGeneration !== null && generation < newestGeneration) {
    self.postMessage({ type: 'result', requestId, generation, result: cancelledGemRecommendation() });
    return;
  }
  newestGeneration = generation;
  self.postMessage({ type: 'result', requestId, generation, result: engine.recommend(message.input) });
});
