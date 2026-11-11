import { createConnect } from './connect.js';

// code-browser's run_code members, declared under `runCode` in conductor.plugin.json. cc calls this factory with
// ctx = {pluginId, baseUrl, caller, cc} and serves each property of the returned object as `cc.code_browser.<name>`.
// Without cc, a program imports this file by the URL in browser_info's `helper.module` and calls the factory itself with
// {cc}. Only `ctx.cc` is read.
//
// The factory does no I/O: cc fails the whole namespace for the run when it throws, so a browser that is not running yet
// must fail at connect(), not here.
export default function codeBrowserMembers(ctx) {
  const cc = ctx?.cc;
  if (cc === null || (typeof cc !== 'object' && typeof cc !== 'function')) throw new TypeError("code-browser's run_code members need ctx.cc, the program's cc object");
  return { connect: createConnect(cc) };
}
