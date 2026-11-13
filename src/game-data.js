const { randomInt, createHash } = require('node:crypto');

const EMOJIS = [...new Set(['🦊', '🐼', '🐨', '🐱', '🐶', '🐸', '🦁', '🐯', '🦄', '🐙', '🦉', '🐧', '🐵', '🐰', '🐻', '🐢', '🐬', '🦋', '🐝', '🦖',
  ...[[0x1F400, 0x1F43E], [0x1F600, 0x1F637], [0x1F347, 0x1F37F], [0x1F680, 0x1F6A5], [0x1F330, 0x1F33C], [0x1F300, 0x1F320]]
    .flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)))])];

function fail(status, message, code) { throw Object.assign(new Error(message), { status, publicMessage: message, publicCode: code }); }
function nameOf(value) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 24) fail(400, 'Use a player name of 1–24 characters.');
  return value.trim().replace(/\s+/g, ' ');
}
function token(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value); }
function integer(value, max = 1000000000) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function canonicalPlayers(input, imported = false) {
  if (!Array.isArray(input) || input.length < 1 || input.length > (imported ? 500 : 2)) fail(400, 'Invalid player results.');
  const players = input.map((p) => {
    if (!p || !integer(p.score) || !integer(p.wins, imported ? 1000000 : 6)) fail(400, 'Invalid scores or round wins.');
    if (imported && (!integer(p.games, 1000000) || (p.best_score !== null && !integer(p.best_score)))) fail(400, 'Invalid legacy score history.');
    return { name: nameOf(p.name), score: p.score, wins: p.wins, games: imported ? p.games : 1,
      best_score: imported ? p.best_score : p.score };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(players.map((p) => p.name)).size !== players.length) fail(400, 'Player names must be distinct.');
  return players;
}

class GameDataService {
  constructor(repository) { this.repo = repository; this.cache = null; }
  async health() { return { status: 'ok', generation: await this.repo.generation() }; }
  async settings() { return { settings: await this.repo.settings() }; }
  async saveSettings(body) {
    const s = body?.settings;
    const number = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
    if (!s || typeof s.model_key !== 'string' || s.model_key.length > 100
      || !Number.isInteger(s.round_seconds) || !number(s.round_seconds, 10, 600)
      || !Number.isInteger(s.required_hits) || !number(s.required_hits, 1, 10)
      || !number(s.confidence_threshold, .01, 1) || !number(s.prediction_gap_seconds, .1, 5)
      || !Array.isArray(s.cosmetic_draw_seconds_by_round) || s.cosmetic_draw_seconds_by_round.length !== 6
      || !s.cosmetic_draw_seconds_by_round.every((v) => number(v, 0, 10))
      || !Array.isArray(s.excluded_classes) || !s.excluded_classes.every((v) => typeof v === 'string')
      || !s.class_difficulties || Array.isArray(s.class_difficulties) || typeof s.class_difficulties !== 'object'
      || !Object.values(s.class_difficulties).every((v) => ['easy', 'medium', 'hard'].includes(v))) {
      fail(400, 'Invalid admin settings.');
    }
    const settings = Object.fromEntries(['model_key', 'round_seconds', 'required_hits', 'confidence_threshold',
      'prediction_gap_seconds', 'cosmetic_draw_seconds_by_round', 'excluded_classes', 'class_difficulties'].map((key) => [key, s[key]]));
    await this.repo.saveSettings(settings);
    return { status: 'saved' };
  }
  async profile(name, preferred) {
    name = nameOf(name);
    const old = await this.repo.profile(name);
    if (old) return old;
    for (let attempt = 0; attempt < EMOJIS.length; attempt++) {
      const used = new Set(await this.repo.emojis());
      const choices = EMOJIS.filter((emoji) => !used.has(emoji));
      const emoji = preferred && EMOJIS.includes(preferred) && !used.has(preferred) ? preferred : choices.length ? choices[randomInt(choices.length)] : null;
      if (!emoji) fail(409, 'All unique avatars are assigned. Existing players can still play.');
      try { return await this.repo.insertProfile({ name, emoji }); }
      catch (error) {
        if (error.code !== 11000) throw error;
        const existing = await this.repo.profile(name);
        if (existing) return existing;
      }
    }
    fail(503, 'Could not allocate an avatar. Please retry.');
  }
  async resolve(body) { return { ...await this.profile(body?.name), generation: await this.repo.generation() }; }
  async rows(generation) {
    if (!this.cache || this.cache.generation !== generation || this.cache.expires <= Date.now()) {
      const scores = await this.repo.rankings(generation);
      const profiles = await this.repo.profiles(scores.map((p) => p.name));
      const emojis = new Map(profiles.map((p) => [p.name, p.emoji]));
      this.cache = { generation, expires: Date.now() + 2000,
        rows: scores.map((p, i) => ({ ...p, rank: i + 1, emoji: emojis.get(p.name) || null })) };
    }
    return this.cache.rows;
  }
  async leaderboard(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'Limit must be from 1 to 100.');
    const generation = await this.repo.generation();
    const players = (await this.rows(generation)).slice(0, limit);
    if (await this.repo.generation() !== generation) fail(503, 'Leaderboard changed. Please retry.');
    return { generation, players };
  }
  async save(id, body) {
    if (!token(id) || !token(body?.generation)) fail(400, 'Invalid completion ID or generation.');
    const generation = await this.repo.generation();
    if (body.generation !== generation) fail(409, 'Leaderboard was reset; this submission belongs to an older generation.', 'stale_generation');
    const players = canonicalPlayers(body.players);
    if (body.completed_at !== undefined && (!Number.isFinite(body.completed_at) || body.completed_at <= 0)) fail(400, 'Invalid completion time.');
    const hash = createHash('sha256').update(JSON.stringify({ generation, players, completed_at: body.completed_at })).digest('hex');
    let match = await this.repo.match(id);
    if (match && match.hash !== hash) fail(409, 'This completion ID already has different results.');
    if (!match) {
      const previous = new Map((await this.rows(generation)).map((p) => [p.name, p.score]));
      for (const p of players) await this.profile(p.name);
      const record = { id, generation, hash, completed_at: body.completed_at ?? Date.now() / 1000,
        players: players.map((p) => ({ ...p, previous_best: previous.get(p.name) ?? null })) };
      try { match = await this.repo.insertMatch(record); }
      catch (error) {
        if (error.code !== 11000) throw error;
        match = await this.repo.match(id);
        if (!match || match.hash !== hash) fail(409, 'This completion ID already has different results.');
      }
    }
    if (await this.repo.generation() !== generation) fail(409, 'Leaderboard was reset during the save.', 'stale_generation');
    this.cache = null;
    const positions = new Map((await this.rows(generation)).map((p) => [p.name, p]));
    if (await this.repo.generation() !== generation) fail(409, 'Leaderboard was reset during the save.', 'stale_generation');
    return { status: 'saved', completion_id: id, generation, rankings: match.players.map((p) => {
      const position = positions.get(p.name);
      return { name: p.name, rank: position.rank, high_score: position.score,
        new_high_score: p.score > (p.previous_best || 0) && p.score === position.score };
    }) };
  }
  async reset(body) {
    if (!token(body?.generation) || !token(body?.reset_id)) fail(400, 'Invalid reset request.');
    const generation = await this.repo.reset(body.generation, body.reset_id);
    if (generation !== body.reset_id) fail(409, 'Leaderboard changed. Refresh before resetting.', 'generation_conflict');
    this.cache = null;
    return { status: 'reset', generation };
  }
  async importLegacy(body) {
    const players = canonicalPlayers(body?.players, true);
    const profiles = body.profiles;
    if (!Array.isArray(profiles) || profiles.length > 500 || profiles.some((p) => !p || !EMOJIS.includes(p.emoji))) fail(400, 'Invalid legacy profiles.');
    const normalized = profiles.map((p) => ({ name: nameOf(p.name), emoji: p.emoji })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const generation = await this.repo.generation();
    const hash = createHash('sha256').update(JSON.stringify({ generation, players, profiles: normalized })).digest('hex');
    const id = `legacy_${hash}`;
    if (await this.repo.match(id)) return { status: 'already_imported', generation };
    if (await this.repo.hasMatches(generation)) fail(409, 'Import requires an empty leaderboard.');
    for (const p of normalized) await this.profile(p.name, p.emoji);
    for (const p of players) await this.profile(p.name);
    try { await this.repo.insertMatch({ id, generation, hash, players }); }
    catch (error) { if (error.code !== 11000) throw error; }
    this.cache = null;
    return { status: 'imported', generation };
  }
}

module.exports = { GameDataService, EMOJIS };
