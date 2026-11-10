// The warnings an agent is shown with a browser (`notes` in browser_info/start_browser). The run_code helper imports
// HUMAN_NOTE too, so this module has no imports: it loads in a plan-mode program.

export const HUMAN_NOTE = 'A human currently has control of this browser. Do not drive it: do not click, type or navigate. '
  + 'The run_code helper is refused while a human has control. '
  + 'Call browser_info again later; it shows controller "agent" once control is back.';

export const UNSANDBOXED_NOTE = "WARNING: this browser runs without Chromium's sandbox (the host has no usable one), so a compromised page could "
  + 'run code as the host user. Do not browse untrusted pages in it, especially with logged-in profiles.';

export const ATTACHED_NOTE = "This is the user's own browser, which they attached in the panel: its other tabs and logged-in sessions are theirs. "
  + "Work in your own tab and do not close tabs you did not open. `sandbox` is null because code-browser did not launch it, "
  + 'so nothing is known about its sandbox or profile. stop_browser only disconnects, and only the user can reconnect it. '
  + 'A person may be using its window right now.';

export const APPROVAL_NOTE = 'Chrome asks the user "Allow remote debugging?" for every new connection to this browser. '
  + "The run_code helper uses code-browser's connection, which the user already allowed, and asks nothing. "
  + 'Each Bash snippet script opens a new connection: tell the user before you run one; it waits until they click Allow '
  + 'and fails with 403 if they cancel. Do the work in as few snippet scripts as possible.';
