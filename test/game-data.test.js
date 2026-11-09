const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { GameDataService } = require('../src/game-data');
const { createApp } = require('../src/app');

class MemoryRepository {
  constructor() { this.epoch = 'initial-generation-000001'; this.people = new Map(); this.matches = new Map(); }
  async generation() { return this.epoch; }
  async profile(name) { return this.people.get(name); }
  async emojis() { return [...this.people.values()].map((p) => p.emoji); }
  async insertProfile(profile) {
    if (this.people.has(profile.name) || [...this.people.values()].some((p) => p.emoji === profile.emoji)) throw Object.assign(new Error('duplicate'), { code: 11000 });
    this.people.set(profile.name, { ...profile }); return { ...profile };
  }
  async profiles(names) { return [...this.people.values()].filter((p) => names.includes(p.name)); }
  async match(id) { return this.matches.get(id); }
  async insertMatch(match) {
    if (this.matches.has(match.id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
    this.matches.set(match.id, structuredClone(match));
    if (this.failAfterInsert) { this.failAfterInsert = false; throw new Error('lost acknowledgement'); }
    return this.matches.get(match.id);
  }
  async hasMatches(generation) { return [...this.matches.values()].some((m) => m.generation === generation); }
  async rankings(generation) {
    const rows = new Map();
    for (const match of this.matches.values()) {
      if (match.generation !== generation) continue;
      for (const player of match.players) {
        const row = rows.get(player.name) || { name: player.name, score: null, games: 0, wins: 0 };
        if (player.best_score !== null) row.score = Math.max(row.score ?? player.best_score, player.best_score);
        row.games += player.games; row.wins += player.wins; rows.set(player.name, row);
      }
    }
    return [...rows.values()].filter((p) => p.score !== null)
      .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  async reset(generation, next) { if (this.epoch === generation) this.epoch = next; return this.epoch; }
}

const KEY = 'test-shared-service-key-longer-than-thirty-two-characters';
let repo, service, server, base;
beforeEach(async () => {
  repo = new MemoryRepository(); service = new GameDataService(repo);
  server = createApp({ store: {}, gameData: service, uploadApiKey: KEY, publicBaseUrl: 'https://art.example.com', logger: { error() {} } }).listen(0, '127.0.0.1');
  await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed;
});
function request(path, method = 'GET', payload, key = KEY) {
  return fetch(base + '/game-data' + path, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
}
function match(scoreA = 3000, scoreB = 1500) {
  return { generation: repo.epoch, players: [{ name: 'Alice', score: scoreA, wins: 3 }, { name: 'Bob', score: scoreB, wins: 2 }] };
}

test('game data uses the existing upload key and rejects public writes and reset', async () => {
  for (const [path, method, body] of [['/health', 'GET'], ['/players/resolve', 'POST', { name: 'Alice' }], ['/matches/match-identity-000001', 'PUT', match()], ['/reset', 'POST', {}]]) {
    assert.equal((await request(path, method, body, 'wrong')).status, 401);
  }
  const response = await request('/health');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).generation, repo.epoch);
});
test('profiles are persistent and avatars stay unique under concurrent requests', async () => {
  const profiles = await Promise.all(Array.from({ length: 30 }, (_, i) => service.resolve({ name: `Player ${i}` })));
  assert.equal(new Set(profiles.map((p) => p.emoji)).size, 30);
  const restarted = new GameDataService(repo);
  assert.equal((await restarted.resolve({ name: 'Player 0' })).emoji, profiles[0].emoji);
  assert.equal(repo.people.size, 30);
});
test('one completed document saves both players and retries cannot double-count', async () => {
  const payload = match();
  assert.equal((await request('/matches/match-identity-000001', 'PUT', payload)).status, 200);
  assert.equal((await request('/matches/match-identity-000001', 'PUT', payload)).status, 200);
  assert.equal(repo.matches.size, 1);
  const rows = (await (await request('/leaderboard')).json()).players;
  assert.deepEqual(rows.map((p) => [p.name, p.score, p.games]), [['Alice', 3000, 1], ['Bob', 1500, 1]]);
  assert.equal((await request('/matches/match-identity-000001', 'PUT', match(9999))).status, 409);
});
test('acknowledgement lost after database insertion is safe to retry', async () => {
  repo.failAfterInsert = true;
  assert.equal((await request('/matches/match-identity-000001', 'PUT', match())).status, 500);
  const response = await request('/matches/match-identity-000001', 'PUT', match());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).rankings[0].new_high_score, true);
  assert.equal((await service.leaderboard()).players[0].games, 1);
});
test('replays use single-game high score, preserve counts, and only higher scores celebrate', async () => {
  await service.save('match-identity-000001', match());
  const lower = await service.save('match-identity-000002', match(2500, 1075));
  assert.equal(lower.rankings.find((p) => p.name === 'Alice').new_high_score, false);
  const higher = await service.save('match-identity-000003', match(4000, 4000));
  assert.equal(higher.rankings.find((p) => p.name === 'Alice').new_high_score, true);
  const restarted = new GameDataService(repo);
  const rows = (await restarted.leaderboard()).players;
  assert.deepEqual(rows.map((p) => [p.name, p.score, p.games, p.wins]), [['Alice', 4000, 3, 9], ['Bob', 4000, 3, 6]]);
});
test('global ranking includes players outside the displayed top twenty', async () => {
  for (let i = 0; i < 21; i++) await service.save(`match-identity-${String(i).padStart(6, '0')}`, { generation: repo.epoch, players: [{ name: `Leader ${i}`, score: 5000 + i, wins: 2 }] });
  const result = await service.save('match-identity-last000', match(2000, 1000));
  assert.deepEqual(result.rankings.map((p) => p.rank), [22, 23]);
  assert.equal((await service.leaderboard()).players.length, 20);
});
test('reset is idempotent, retains profiles, and old deliveries cannot restore cleared scores', async () => {
  await service.save('match-identity-000001', match());
  const avatar = (await service.resolve({ name: 'Alice' })).emoji;
  const old = repo.epoch;
  const reset = { generation: old, reset_id: 'reset-request-identity-00001' };
  await service.reset(reset);
  await service.save('match-identity-000002', match(1000, 500));
  await service.reset(reset); // Duplicate reset must not clear the new completion.
  assert.equal((await service.leaderboard()).players[0].score, 1000);
  assert.equal((await service.resolve({ name: 'Alice' })).emoji, avatar);
  const response = await request('/matches/match-identity-old000', 'PUT', { ...match(), generation: old });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'stale_generation');
});
test('invalid scores, duplicate names, malformed JSON and invalid limits are rejected', async () => {
  for (const score of [-1, 1.5, '1000', true, Infinity]) assert.equal((await request('/matches/match-identity-000001', 'PUT', match(score))).status, 400);
  const payload = match(); payload.players[1].name = 'Alice';
  assert.equal((await request('/matches/match-identity-000001', 'PUT', payload)).status, 400);
  assert.equal((await request('/leaderboard?limit=0')).status, 400);
  const broken = await fetch(base + '/game-data/players/resolve', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(broken.status, 400);
});
test('legacy import preserves known best scores and emojis and refuses mixing live history', async () => {
  const payload = { players: [{ name: 'Alice', score: 5500, best_score: 3000, games: 2, wins: 3 },
    { name: 'Unknown', score: 9000, best_score: null, games: 3, wins: 4 }], profiles: [{ name: 'Alice', emoji: '🦊' }] };
  assert.equal((await service.importLegacy(payload)).status, 'imported');
  assert.equal((await service.importLegacy(payload)).status, 'already_imported');
  assert.equal((await service.leaderboard()).players[0].score, 3000);
  assert.equal((await service.resolve({ name: 'Alice' })).emoji, '🦊');
  await assert.rejects(service.importLegacy({ ...payload, profiles: [] }), (error) => error.status === 409);
});
