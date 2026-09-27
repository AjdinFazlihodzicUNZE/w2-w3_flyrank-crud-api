const { z } = require("zod");

const TriageInput = z.object({
  text: z
    .string()
    .min(1, "text must not be empty")
    .max(2000, "text must be 2000 characters or fewer"),
});

const TriageOutput = z.object({
  category: z.enum(["billing", "bug", "feature", "other"]),
  urgency: z.enum(["low", "normal", "high"]),
  team: z.enum(["support", "engineering", "billing", "product"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(300),
});

module.exports = { TriageInput, TriageOutput };