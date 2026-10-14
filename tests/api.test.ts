import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { get } from 'node:http';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';
import type { Dashboard, Rule } from '../shared/types.js';
test('API 管理规则、配置、来源和重复触发；拒绝越界/外站请求且无密钥泄露', async () => {
  const store = new Store(':memory:'); const app = createApp(store, { request: async () => { throw new Error('network not used'); } }); const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (url: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(`${base}${url}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await request('/health')).status, 200); assert.equal((await request('/rules', 'POST', { name: '' })).status, 400);
    const response = await request('/rules', 'POST', { name: 'API test', query: 'AI coding', kind: 'keyword', enabled: false, notify: true }); assert.equal(response.status, 201); const rule = await response.json() as Rule;
    assert.equal((await request(`/rules/${rule.id}`, 'PATCH', { enabled: true })).status, 200); assert.equal((await request('/scan', 'POST')).status, 202); assert.equal((await request('/scan', 'POST')).status, 200);
    assert.equal((await request('/settings', 'PATCH', { aiDailyLimit: 0 })).status, 400); assert.equal((await request('/settings', 'PATCH', { recipient: 'test@example.com', model: 'test/model' })).status, 200);
    assert.equal((await request('/sources', 'POST', { name: 'Private', url: 'http://127.0.0.1/private' })).status, 400);
    assert.equal((await request('/rules', 'POST', { name: 'External', query: 'test', kind: 'keyword', enabled: true, notify: true }, { Origin: 'https://attacker.example' })).status, 403);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => { get(`${base}/health`, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject); }); assert.equal(hostStatus, 403);
    const state = await (await request('/dashboard')).json() as Dashboard; assert.equal(state.intervalMinutes, 30); assert.equal(state.rules.length, 1); const text = JSON.stringify(state); assert.ok(!text.includes('OPENROUTER_API_KEY')); assert.ok(!text.includes('SMTP_PASS'));
    assert.equal((await request(`/rules/${rule.id}`, 'DELETE')).status, 200); assert.equal((await request('/unknown')).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
