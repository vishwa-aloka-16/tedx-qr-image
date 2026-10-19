const Artwork = require('./models/Artwork');

module.exports = {
  async put(id, image, etag) {
    const result = await Artwork.updateOne({ _id: id }, { $set: { image, etag } },
      { upsert: true, runValidators: true });
    return result.upsertedCount > 0;
  },
  async get(id) {
    const record = await Artwork.findById(id).select('+image').exec();
    return record ? { image: record.image, etag: record.etag } : null;
  },
};
