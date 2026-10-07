const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./openapi.json');
const { pool, initDb } = require('./db');
const { z } = require("zod");
const { TriageInput , TriageOutput} = require("./llm/schema");
const fs = require("fs");
const path = require("path");
const client = require("./llm/client");

const PROMPT_VERSION = "v1";
const PROMPT_PATH = path.join(__dirname, "prompts", `triage-${PROMPT_VERSION}.md`);
const QUARANTINE_PATH = path.join(__dirname, "logs", "quarantine.jsonl");

const app = express();
const port = 3000;


app.use(express.json());
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

initDb().then(() => {
  console.log('Connected to Postgres successfully');
}).catch((err) => {
  console.error('Failed to load Postgres DB:', err);
}); 

app.get('/',(req,res)=>{
    res.json({ "name": "Task API", "version": "1.0", "endpoints": ["/tasks"] });
})
app.get('/health',(req,res) => {
    res.json({"status" : "ok"})
})
app.get('/tasks',async(req,res) => {
    try {
    const result = await pool.query('SELECT * FROM tasks ORDER BY id ASC');
    res.json(result.rows);
    } catch (err) {
    console.error('Error fetching tasks:', err);
    res.status(500).json({ error: 'Internal server error' });
    }
})
app.get('/tasks/:id',async(req,res) => {
    try {
    const taskId = req.params.id;
   
    const result = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching task:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
})
app.post('/tasks', async (req, res) => {
  const { title } = req.body;

  if (!title || title.trim() === '') {
    return res.status(400).json({ error: 'Title is required' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO tasks (title, done) VALUES ($1, $2) RETURNING *',
      [title.trim(), false]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating task:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.put('/tasks/:id', async (req, res) => {
  const taskId = req.params.id;
  const { title, done } = req.body;

  // Validation: Check if title is valid string when provided
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
    return res.status(400).json({ error: 'Title cannot be empty' });
  }

  try {
   
    const existing = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const updatedTitle = title !== undefined ? title.trim() : existing.rows[0].title;
    const updatedDone = done !== undefined ? Boolean(done) : existing.rows[0].done;

    const result = await pool.query(
      'UPDATE tasks SET title = $1, done = $2 WHERE id = $3 RETURNING *',
      [updatedTitle, updatedDone, taskId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating task:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.delete('/tasks/:id', async (req, res) => {
  const taskId = req.params.id;

  try {
    const result = await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting task:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.post("/triage", async (req, res) => {
  const parsed = TriageInput.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return res.status(400).json({
      error: "Invalid input",
      field: first.path.join("."),
      detail: first.message,
    });
  }
  if (process.env.LLM_STUB === "1") {
    return res.json({
      category: "bug",
      urgency: "normal",
      team: "engineering",
      confidence: 0.9,
      reason: "Stub mode reply — no model was called.",
    });
  }
  const systemPrompt = fs.readFileSync(PROMPT_PATH, "utf8");
  const userText = parsed.data.text;
  let raw1;
  try {
    const response1 = await client.chat.completions.create({
      model: process.env.LLM_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ text: userText }) },
      ],
    });
    raw1 = response1.choices[0].message.content;
  } catch (err) {
    console.error("Model call 1 failed:", err.message);
    return res.status(500).json({ error: "Model call failed" });
  }
  const result1 = parseAndValidateTriage(raw1);
  if (result1.success) {
    return res.json(result1.data);
  }
  console.warn(`[triage ${PROMPT_VERSION}] Attempt 1 rejected (${result1.error}). Attempting repair...`);
  let raw2;
  try {
    const response2 = await client.chat.completions.create({
      model: process.env.LLM_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ text: userText }) },
        { role: "assistant", content: raw1 },
        {
          role: "user",
          content: `Your previous answer was rejected for this reason: ${result1.error}. Return only corrected JSON matching the schema.`,
        },
      ],
    });
    raw2 = response2.choices[0].message.content;
  } catch (err) {
    console.error("Repair model call failed:", err.message);
    logQuarantine({
      input: userText,
      rawOutput: raw1,
      error: `Repair call threw network error: ${err.message}`,
      promptVersion: PROMPT_VERSION,
    });
    return res.status(500).json({ error: "Model repair call failed" });
  }
  const result2 = parseAndValidateTriage(raw2);
  if (result2.success) {
    console.log(`[triage ${PROMPT_VERSION}] Repair succeeded!`);
    return res.json(result2.data);
  }
  console.error(`[triage ${PROMPT_VERSION}] Repair failed. Quarantining output.`);
  logQuarantine({
    input: userText,
    rawOutput: raw2,
    error: result2.error,
    promptVersion: PROMPT_VERSION,
  });
  return res.status(422).json({
    error: "Model output failed schema validation after repair retry",
    detail: result2.error,
  });
});

function parseAndValidateTriage(raw) {
  if (!raw || typeof raw !== "string") {
     return { success: false, error: "Model returned empty or non-string response", raw };
  }
 
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return { success: false, error: "No JSON object found in model response", raw };
  }

  const jsonSubstring = cleaned.substring(firstBrace, lastBrace + 1);

  let parsedJson;
  try {
    parsedJson = JSON.parse(jsonSubstring);
  } catch (err) {
    return { success: false, error: `JSON parse failed: ${err.message}`, raw };
  }

  const zodResult = TriageOutput.safeParse(parsedJson);
  if (!zodResult.success) {
    const errorDetails = zodResult.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    return { success: false, error: `Schema validation failed: ${errorDetails}`, raw };
  }

  return { success: true, data: zodResult.data };
}
function logQuarantine({ input, rawOutput, error, promptVersion }) {
  try {
    
    const logsDir = path.dirname(QUARANTINE_PATH);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    const entry = {
      timestamp: new Date().toISOString(),
      prompt_version: promptVersion,
      input,
      raw_output: rawOutput,
      error,
    };
   
    fs.appendFileSync(QUARANTINE_PATH, JSON.stringify(entry) + "\n", "utf8");
    console.log(`[quarantine] Logged invalid response to ${QUARANTINE_PATH}`);
  } catch (err) {
    console.error("Failed to write quarantine log:", err.message);
  }
}
app.listen(port, () => console.log(`its alive on http://localhost:${port}`));

