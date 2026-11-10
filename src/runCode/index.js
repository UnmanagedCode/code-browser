import { createConnect } from './connect.js';

// code-browser's run_code module. cc calls this factory once per requested name with
// ctx = {pluginId, baseUrl, caller, cc, module}; `module` is the name the program asked for, or null for
// `cc.code_browser.import()`. Without cc, a program imports this file by the URL in browser_info's `helper.module`
// and calls the factory itself with {cc, module: null}. Only `ctx.cc` and `ctx.module` are read.
//
// The factory does no I/O: cc memoizes a failed load for the rest of the run, so a browser that is not running yet must
// fail at connect(), not here.
const MODULES = new Map([
  [null, (cc) => ({ connect: createConnect(cc) })],
]);

const describeName = (name) => (name === null ? 'the default module (import() with no name)' : `'${name}'`);

export default function codeBrowserModule(ctx) {
  const name = ctx?.module ?? null;
  if (!MODULES.has(name)) {
    const err = new Error(`code-browser has no module ${describeName(name)}; its modules: ${[...MODULES.keys()].map(describeName).join(', ')}`);
    err.code = 'MODULE_UNKNOWN';
    throw err;
  }
  const cc = ctx?.cc;
  if (cc === null || (typeof cc !== 'object' && typeof cc !== 'function')) throw new TypeError("code-browser's module needs ctx.cc, the program's cc object");
  return MODULES.get(name)(cc);
}
