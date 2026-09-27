const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./openapi.json');
const { pool, initDb } = require('./db');
const { z } = require("zod");
const { TriageInput } = require("./llm/schema");
const fs = require("fs");
const path = require("path");
const client = require("./llm/client");

const PROMPT_VERSION = "v1";
const PROMPT_PATH = path.join(__dirname, "prompts", `triage-${PROMPT_VERSION}.md`);

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

  const systemPrompt = fs.readFileSync(PROMPT_PATH, "utf8");

  let raw;
  try {
    const response = await client.chat.completions.create({
      model: process.env.LLM_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ text: parsed.data.text }) },
      ],
    });
    raw = response.choices[0].message.content;
  } catch (err) {
    console.error("Model call failed:", err.message);
    return res.status(500).json({ error: "Model call failed" });
  }

  console.log(`[triage ${PROMPT_VERSION}] model replied:`, raw);

  return res.json({ raw_model_output: raw, prompt_version: PROMPT_VERSION });
});
app.listen(port, () => console.log(`its alive on http://localhost:${port}`));

