import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPubliclyReachable } from './reachability.js';

const hook = (origin: string) => `${origin}/api/connections/strava/webhook`;

test('private and tailnet addresses are not reachable from the internet', () => {
  for (const origin of [
    'https://localhost',
    'https://app.localhost',
    'https://127.0.0.1',
    'https://10.0.0.5',
    'https://172.16.0.1',
    'https://172.31.255.254',
    'https://192.168.40.100',
    'https://169.254.1.1',
    // The case that shipped wrong: Tailscale's CGNAT range read as public.
    'https://100.93.81.36',
    'https://100.64.0.1',
    'https://100.127.255.255',
    'https://[::1]',
    'https://[fd7a:115c:a1e0::c12d:5125]',
    'https://[fe80::1]',
    'https://server-jarvis',
    'https://nas.local',
    'https://lab.home.arpa',
    'https://box.internal',
  ]) {
    assert.equal(isPubliclyReachable(hook(origin)), false, origin);
  }
});

test('public addresses and hostnames are left for Strava to judge', () => {
  for (const origin of [
    'https://lab.example.com',
    'https://server-jarvis.tail1234.ts.net',
    'https://8.8.8.8',
    // Neighbours of the private ranges, which a sloppy prefix check catches.
    'https://100.63.255.255',
    'https://100.128.0.1',
    'https://172.15.0.1',
    'https://172.32.0.1',
    'https://[2606:4700::1111]',
  ]) {
    assert.equal(isPubliclyReachable(hook(origin)), true, origin);
  }
});

test('plain http and garbage are never reachable', () => {
  assert.equal(isPubliclyReachable('http://lab.example.com/hook'), false);
  assert.equal(isPubliclyReachable('not a url'), false);
});
