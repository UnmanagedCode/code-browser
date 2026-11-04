// A timer that never keeps the process alive. Returns its cancel function.
export const unrefTimeout = (fn, ms) => {
  const h = setTimeout(fn, ms);
  h.unref();
  return () => clearTimeout(h);
};
