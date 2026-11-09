// Test-only entry: in production CanvasDO lives in the game script (script_name binding).
// Here it is exported from the same Worker so tests exercise the real classes together.
export { CanvasDO } from '@brickplace/game';
export { default, FanoutDO } from '../src/index.ts';
