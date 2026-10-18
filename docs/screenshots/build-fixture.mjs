// Retain the old refresh command while sourcing contracts from the real backend.
import { captureScreenshots } from './capture.mjs';

await captureScreenshots();
console.log('Refreshed documentation capture using an isolated authenticated backend.');
