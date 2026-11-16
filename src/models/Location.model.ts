import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export interface ILocation {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** GeoJSON point. NOTE: coordinates are [longitude, latitude] */
  location: {
    type: 'Point';
    coordinates: [number, number];
  };
  /** Location is automatically deleted after this time (see LOCATION_RETENTION_MINUTES) */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type LocationDocument = HydratedDocument<ILocation>;

const pointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (value: number[]): boolean =>
          value.length === 2 &&
          value[0] >= -180 &&
          value[0] <= 180 && // longitude
          value[1] >= -90 &&
          value[1] <= 90, // latitude
        message: 'coordinates must be [longitude, latitude] within valid ranges',
      },
    },
  },
  { _id: false },
);

const locationSchema = new Schema<ILocation>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    location: { type: pointSchema, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Enables fast "within X metres" queries
locationSchema.index({ location: '2dsphere' });
// Privacy: MongoDB deletes stale locations automatically
locationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Location = model<ILocation>('Location', locationSchema);