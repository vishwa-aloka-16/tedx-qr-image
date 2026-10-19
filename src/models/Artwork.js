const mongoose = require('mongoose');

const artworkSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  image: { type: Buffer, required: true, select: false },
  etag: { type: String, required: true },
}, { timestamps: true, bufferCommands: false, versionKey: false });

module.exports = mongoose.model('SharedArtwork', artworkSchema);
