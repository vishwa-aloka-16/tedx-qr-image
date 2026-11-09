const mongoose = require('mongoose');
const { randomBytes } = require('node:crypto');
const options = { versionKey: false, bufferCommands: false };
const profileSchema = new mongoose.Schema({ _id: String, emoji: { type: String, required: true, unique: true } }, options);
const resultSchema = new mongoose.Schema({ name: String, score: Number, best_score: Number,
  wins: Number, games: Number, previous_best: Number }, { _id: false });
const matchSchema = new mongoose.Schema({ _id: String, generation: { type: String, required: true, index: true },
  hash: String, completed_at: Number, players: [resultSchema] }, { ...options, timestamps: true });
const stateSchema = new mongoose.Schema({ _id: String, generation: { type: String, required: true } }, options);
const Profile = mongoose.model('GamePlayerProfile', profileSchema, 'game_player_profiles');
const Match = mongoose.model('CompletedGameMatch', matchSchema, 'game_matches');
const State = mongoose.model('GameLeaderboardState', stateSchema, 'game_leaderboard_state');

const repository = {
  async initialize() { await Promise.all([Profile.init(), Match.init(), State.init()]); await this.generation(); },
  async generation() {
    let state;
    try { state = await State.findOneAndUpdate({ _id: 'leaderboard' },
      { $setOnInsert: { generation: randomBytes(24).toString('base64url') } }, { upsert: true, new: true }).lean(); }
    catch (error) { if (error.code !== 11000) throw error; state = await State.findById('leaderboard').lean(); }
    return state.generation;
  },
  async profile(name) { const p = await Profile.findById(name).lean(); return p ? { name: p._id, emoji: p.emoji } : null; },
  async insertProfile(p) { await Profile.create({ _id: p.name, emoji: p.emoji }); return p; },
  async emojis() { return Profile.distinct('emoji'); },
  async profiles(names) { return (await Profile.find({ _id: { $in: names } }).lean()).map((p) => ({ name: p._id, emoji: p.emoji })); },
  async match(id) { return Match.findById(id).lean(); },
  async insertMatch(record) { const doc = await Match.create({ _id: record.id, generation: record.generation, hash: record.hash, completed_at: record.completed_at, players: record.players }); return doc.toObject(); },
  async hasMatches(generation) { return Boolean(await Match.exists({ generation })); },
  async rankings(generation) {
    return Match.aggregate([
      { $match: { generation } }, { $unwind: '$players' },
      { $group: { _id: '$players.name', score: { $max: '$players.best_score' },
        wins: { $sum: '$players.wins' }, games: { $sum: '$players.games' } } },
      { $match: { score: { $ne: null } } }, { $sort: { score: -1, _id: 1 } },
      { $project: { _id: 0, name: '$_id', score: 1, wins: 1, games: 1 } },
    ]).collation({ locale: 'simple' });
  },
  async reset(generation, next) {
    const state = await State.findOneAndUpdate({ _id: 'leaderboard', generation }, { $set: { generation: next } }, { new: true }).lean();
    return state?.generation || await this.generation();
  },
};
module.exports = { repository, Profile, Match, State };
