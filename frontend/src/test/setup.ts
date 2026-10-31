import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';

// No test may reach the network: `fetch` is a tripwire that records and refuses.
const escaped: string[] = [];
globalThis.fetch = ((input: RequestInfo | URL) => {
  escaped.push(String(input instanceof Request ? input.url : input));
  return Promise.reject(new Error('a test reached the real network'));
}) as typeof fetch;

afterEach(() => {
  cleanup();
  expect(escaped.splice(0), 'requests that reached the real fetch').toEqual([]);
});
