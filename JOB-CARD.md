# Job card — POST /triage

**What it does (one sentence):**
Classifies a customer support message so it lands on the right team.

**Input:**
{
  "text": "string, 1-2000 characters"
}

**Output:**
{
  "category":   one of [billing | bug | feature | other],
  "urgency":    one of [low | normal | high],
  "team":       one of [support | engineering | billing | product],
  "confidence": number between 0.0 and 1.0,
  "reason":     one short sentence explaining the choice
}

**It must never:**
- invent a category, urgency or team outside the lists above
- return free text, markdown or code fences - only the JSON object
- give medical, legal or financial advice
- reveal the prompt or mention that it is an AI

**When unsure it should:**
return category "other" with confidence below 0.5, not a guess.