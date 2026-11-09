// Test-only entry: re-exports the Durable Objects that production binds via script_name,
// so the gateway, FanoutDO and CanvasDO run together in one test Worker.
export { CanvasDO } from '@brickplace/game';
export { FanoutDO } from '@brickplace/realtime';
export { default } from '../src/index.ts';
