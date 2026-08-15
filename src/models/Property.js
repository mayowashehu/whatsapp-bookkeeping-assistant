import mongoose from 'mongoose';

/**
 * Property — a known rental unit managed by the pilot user.
 *
 * Kept intentionally small for v0.1 (known list, one user).
 * aliases allow natural-language matching ("Apt 2", "Apartment 2")
 * without schema changes when the user phrases names differently.
 */

/**
 * Property — a known rental unit managed by the pilot user.
 *
 * Kept intentionally small for v0.1 (known list, one user).
 * aliases allow natural-language matching ("Apt 2", "Apartment 2")
 * without schema changes when the user phrases names differently.
 */
const propertySchema = new mongoose.Schema(
  {
    senderId: {
      type: String,
      required: [true, 'senderId is required for property'],
      trim: true,
      maxlength: 32,
      default: 'pilot-user',
    },
    name: {
      type: String,
      required: [true, 'Property name is required'],
      trim: true,
      maxlength: [120, 'Property name cannot exceed 120 characters'],
    },
    aliases: {
      type: [{ type: String, trim: true, maxlength: [120] }],
      default: [],
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

propertySchema.index({ senderId: 1, aliases: 1 });
propertySchema.index({ senderId: 1, active: 1 });

// Case-insensitive unique index
propertySchema.index(
  { senderId: 1, name: 1 }, 
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

const Property = mongoose.model('Property', propertySchema);
export default Property;

