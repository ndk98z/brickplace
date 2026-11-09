// Test-only entry: re-exports the CanvasDO that production binds via script_name, so the admin
// Worker and the canvas run together in one test Worker.
export { CanvasDO } from '@brickplace/game';
export { FanoutDO } from '@brickplace/realtime';
export { default } from '../src/index.ts';
